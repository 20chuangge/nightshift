package com.desk.assistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Nightshift's background watcher.
 *
 * Why a foreground service: the phone must tell the user when a turn finished or
 * when the assistant is waiting for an approval, even with the screen off. A
 * WebView that is not visible gets frozen, so the SSE connection has to live in
 * a service instead - the app's own subscription, independent of any screen.
 *
 * What it does: reads the hub address + device token the app stored (Capacitor
 * Preferences -> SharedPreferences "CapacitorStorage"), keeps an SSE connection to
 * /api/stream open, and turns two event kinds into a notification:
 *   - approval.request  "要你确认一下" (something is blocked on the human)
 *   - turn.end          "这一轮结束了" (only for turns the human did not sit and
 *                       watch - the app being in the background is our proxy)
 *
 * The connection is retried with a backoff; a dropped Wi-Fi or a sleeping
 * machine is normal, not an error worth a notification.
 */
public class NightshiftWatcher extends Service {

    private static final String TAG = "nightshift-watch";
    private static final String CHANNEL_SERVICE = "nightshift-service";
    private static final String CHANNEL_EVENTS = "nightshift-events";
    private static final int ID_SERVICE = 4101;
    private static int eventSeq = 4110;

    private volatile boolean running = false;
    private Thread worker;
    /** Every open stream, so onDestroy can drop them all. */
    private final java.util.Set<HttpURLConnection> connections =
            java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());

    /** Set by MainActivity: the user is looking at the app right now. */
    static volatile boolean appVisible = false;

    /** Capacitor Preferences stores everything in one SharedPreferences file. */
    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
    }

    /**
     * The hubs this phone holds a token for, most recently used first.
     *
     * desk.hubUrl is the last machine the user *looked at*, which may be one the
     * phone has no token for (reached through a one-time link) - so the token is
     * what decides, not the last URL.
     */
    private static java.util.List<String> hubsWithToken(SharedPreferences p) {
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        String last = p.getString("desk.hubUrl", null);
        if (last != null) {
            last = last.replaceAll("/+$", "");
            if (p.getString("desk.token:" + last, null) != null) out.add(last);
        }
        for (Map.Entry<String, ?> entry : p.getAll().entrySet()) {
            String key = entry.getKey();
            if (key.startsWith("desk.token:") && entry.getValue() instanceof String) {
                out.add(key.substring("desk.token:".length()));
            }
        }
        return new java.util.ArrayList<>(out);
    }

    static boolean hasPairing(Context context) {
        return !hubsWithToken(prefs(context)).isEmpty();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(ID_SERVICE, serviceNotification(this));
        if (!running) {
            running = true;
            worker = new Thread(this::supervise, "nightshift-supervisor");
            worker.setDaemon(true);
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        for (HttpURLConnection conn : connections) {
            try {
                conn.disconnect();
            } catch (Exception ignored) {
                // already gone
            }
        }
        connections.clear();
        super.onDestroy();
    }

    // ------------------------------------------------------------- supervisors
    /*
     * One thread per hub the phone holds a token for: a notification must arrive
     * whichever machine ran the turn, and each machine has its own event stream.
     * A supervisor re-reads the tokens every 30 s so a machine paired later (or
     * one whose token was removed) is picked up without restarting the app.
     */
    private final Map<String, Thread> workers = new java.util.concurrent.ConcurrentHashMap<>();

    private void supervise() {
        while (running) {
            for (String hub : hubsWithToken(prefs(this))) ensureWorker(hub);
            sleep(30000);
        }
    }

    private void ensureWorker(String hub) {
        Thread alive = workers.get(hub);
        if (alive != null && alive.isAlive()) return;
        Thread worker = new Thread(() -> {
            try {
                watchHub(hub);
            } finally {
                workers.remove(hub);
            }
        }, "nightshift:" + hub);
        worker.setDaemon(true);
        workers.put(hub, worker);
        worker.start();
    }

    /** Keep one hub's stream open, retrying with a backoff. */
    private void watchHub(String hub) {
        int attempt = 0;
        while (running) {
            SharedPreferences p = prefs(this);
            String token = p.getString("desk.token:" + hub, null);
            if (token == null) return; // unpaired or revoked: the supervisor decides
            boolean established = false;
            try {
                established = connectAndRead(hub, token);
            } catch (Exception err) {
                if (!running) return;
                Log.i(TAG, "stream from " + hub + " ended: " + err.getClass().getSimpleName());
            }
            if (!running) return;
            attempt = established ? 1 : Math.min(attempt + 1, 6);
            sleep(Math.min(30000L, 1500L * attempt));
        }
    }

    /** One SSE connection; returns true when it had been established. */
    private boolean connectAndRead(String hub, String token) throws Exception {
        String url = hub + "/api/stream";
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        connections.add(conn);
        try {
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "text/event-stream");
            conn.setRequestProperty("Cache-Control", "no-cache");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(0); // SSE: no read timeout
            int status = conn.getResponseCode();
            if (status == 401) {
                // Revoked on the computer: forget this hub's token, keep the others.
                Log.w(TAG, "token rejected for " + hub);
                prefs(this).edit().remove("desk.token:" + hub).apply();
                return false;
            }
            if (status != 200) throw new IllegalStateException("HTTP " + status);
            Log.i(TAG, "watching " + hub);
            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while (running && (line = reader.readLine()) != null) {
                if (line.startsWith("data: ")) handleEvent(line.substring(6));
            }
            return true;
        } finally {
            try {
                conn.disconnect();
            } catch (Exception ignored) {
                // nothing to do
            }
            connections.remove(conn);
        }
    }

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    /** One SSE event: decide whether the human needs to be told. */
    private void handleEvent(String json) {
        try {
            JSONObject event = new JSONObject(json);
            String type = event.optString("type", "");
            if ("approval.request".equals(type)) {
                // Always worth a buzz: the turn is blocked on a decision.
                String tool = event.optString("tool", "工具");
                String reason = event.optString("reason", "这一步会动到你的东西。");
                notify("要你确认一下", tool + "：" + reason, event.optString("botName", ""));
                return;
            }
            if ("turn.end".equals(type)) {
                // Quiet while the user is already watching that screen.
                if (appVisible) return;
                String status = event.optString("status", "success");
                String summary = event.optString("summary", "");
                String title = "success".equals(status) ? "这一轮做完了" : "这一轮结束了：" + status;
                notify(title, summary.isEmpty() ? "打开夜班看看结果。" : summary, event.optString("botName", ""));
            }
        } catch (Exception err) {
            Log.d(TAG, "bad event: " + err.getMessage());
        }
    }

    // ------------------------------------------------------------ notifications
    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel service = new NotificationChannel(
                CHANNEL_SERVICE, "后台运行", NotificationManager.IMPORTANCE_MIN);
        service.setDescription("夜班在后台盯着任务。关掉它就不再提醒。");
        service.setShowBadge(false);
        manager.createNotificationChannel(service);

        NotificationChannel events = new NotificationChannel(
                CHANNEL_EVENTS, "任务提醒", NotificationManager.IMPORTANCE_HIGH);
        events.setDescription("任务做完、或者助手在等你确认时提醒你。");
        events.enableVibration(true);
        manager.createNotificationChannel(events);
    }

    private PendingIntent openApp(int flags) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // Tapping goes straight to the machine being watched, not the picker.
        java.util.List<String> hubs = hubsWithToken(prefs(this));
        if (!hubs.isEmpty()) intent.putExtra("desk.openHub", hubs.get(0));
        int pending = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pending |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, intent, pending);
    }

    private Notification serviceNotification(Context context) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_SERVICE)
                : new Notification.Builder(context);
        builder.setContentTitle("夜班在后台盯着")
                .setContentText("有结果会提醒你")
                .setSmallIcon(R.drawable.ic_stat_nightshift)
                .setContentIntent(openApp(0))
                .setOngoing(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent stop = new Intent(context, NightshiftWatcher.class);
            stop.setAction("stop");
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            builder.addAction(new Notification.Action.Builder(
                    null, "停止", PendingIntent.getService(context, 7, stop, flags)).build());
        }
        return builder.build();
    }

    private void notify(String title, String body, String botName) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_EVENTS)
                : new Notification.Builder(this);
        builder.setContentTitle(botName.isEmpty() ? title : (title + " · " + botName))
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setSmallIcon(R.drawable.ic_stat_nightshift)
                .setContentIntent(openApp(0))
                .setAutoCancel(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            builder.setVisibility(Notification.VISIBILITY_PRIVATE);
        }
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            int id = eventSeq++;
            if (id > 4199) eventSeq = 4110;
            manager.notify(id, builder.build());
        }
    }
}
