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
import android.service.notification.StatusBarNotification;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;

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
        long lastSync = 0;
        while (running) {
            java.util.List<String> hubs = hubsWithToken(prefs(this));
            for (String hub : hubs) ensureWorker(hub);
            // Every five minutes, ask a hub we know for the machines it knows and
            // pair this phone with any that answer. That is what makes a machine
            // added later (or one that boots later) notify without anyone
            // touching the app - the phone just needs one live hub to learn from.
            if (!hubs.isEmpty() && System.currentTimeMillis() - lastSync > 300000L) {
                lastSync = System.currentTimeMillis();
                for (String hub : hubs) {
                    if (!running) break;
                    syncFleet(hub);
                }
            }
            sleep(30000);
        }
    }

    /**
     * One machine's peer list, turned into device tokens.
     *
     * The hub that knows a machine can hand out a one-time door for it; spending
     * that door on `client:"app"` pairing is exactly what the watcher needs.
     * Nothing is copied between machines: each pairing is its own credential.
     */
    private void syncFleet(String hub) {
        String token = prefs(this).getString("desk.token:" + hub, null);
        if (token == null) return;
        try {
            JSONObject list = new JSONObject(get(hub + "/api/machines", token));
            org.json.JSONArray machines = list.optJSONArray("machines");
            if (machines == null) return;
            for (int i = 0; i < machines.length(); i += 1) {
                JSONObject machine = machines.optJSONObject(i);
                if (machine == null || machine.optBoolean("self")) continue;
                String name = machine.optString("name", "");
                if (name.isEmpty()) continue;
                // A machine has up to two addresses (tailnet, LAN); the phone can
                // usually reach only one, so try them in turn.
                java.util.List<String> targets = new java.util.ArrayList<>();
                String tailnet = machine.optString("tailnetUrl", "").replaceAll("/+$", "");
                String lan = machine.optString("url", "").replaceAll("/+$", "");
                if (!tailnet.isEmpty()) targets.add(tailnet);
                if (!lan.isEmpty() && !lan.equals(tailnet)) targets.add(lan);
                for (String target : targets) {
                    if (prefs(this).getString("desk.token:" + target, null) != null) break;
                    String door = handoff(hub, token, name);
                    if (door.isEmpty()) break; // the machine is off or has no address
                    String code = pairCode(door);
                    if (code.isEmpty()) break;
                    String fresh = pair(target, code);
                    if (!fresh.isEmpty()) {
                        prefs(this).edit().putString("desk.token:" + target, fresh).apply();
                        Log.i(TAG, "paired with " + name + " at " + target);
                        break;
                    }
                }
            }
        } catch (Exception err) {
            Log.d(TAG, "fleet sync from " + hub + " failed: " + err.getClass().getSimpleName());
        }
    }

    /** POST /api/machines/<name>/handoff -> one-time URL (or "" when it cannot). */
    private String handoff(String hub, String token, String name) {
        try {
            return postJson(hub + "/api/machines/" + java.net.URLEncoder.encode(name, "UTF-8") + "/handoff", token, null)
                    .optString("url", "");
        } catch (Exception err) {
            return "";
        }
    }

    /** Pair from a one-time link token; returns the device token or "". */
    private String pair(String hub, String code) {
        try {
            JSONObject body = new JSONObject();
            body.put("code", code);
            body.put("client", "app");
            JSONObject made = postJson(hub + "/api/pair", null, body);
            return made.optString("token", "");
        } catch (Exception err) {
            return "";
        }
    }

    private String pairCode(String door) {
        try {
            java.net.URI uri = java.net.URI.create(door);
            String query = uri.getQuery();
            if (query == null) return "";
            for (String part : query.split("&")) {
                if (part.startsWith("pair=")) return java.net.URLDecoder.decode(part.substring(5), "UTF-8");
            }
        } catch (Exception ignored) {
            // not a URL we understand
        }
        return "";
    }

    private String get(String url, String token) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            if (conn.getResponseCode() != 200) throw new IllegalStateException("HTTP " + conn.getResponseCode());
            java.io.InputStream in = conn.getInputStream();
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            conn.disconnect();
        }
    }

    private JSONObject postJson(String url, String token, JSONObject body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(20000);
            if (token != null) conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);
            byte[] payload = body == null ? new byte[0] : body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            java.io.OutputStream out = conn.getOutputStream();
            out.write(payload);
            out.close();
            int status = conn.getResponseCode();
            java.io.InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            java.io.ByteArrayOutputStream sink = new java.io.ByteArrayOutputStream();
            if (in != null) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) > 0) sink.write(buffer, 0, read);
            }
            String text = new String(sink.toByteArray(), StandardCharsets.UTF_8);
            if (status >= 400) throw new IllegalStateException("HTTP " + status);
            return text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } finally {
            conn.disconnect();
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
            // The hub sends a comment every 15 s. Silence for 45 s means the
            // socket is a zombie (Wi-Fi moved, NAT expired); without a timeout
            // the read blocks forever and approvals stop arriving.
            conn.setReadTimeout(45000);
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
                if (line.startsWith("data: ")) handleEvent(hub, line.substring(6));
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
    private void handleEvent(String hub, String json) {
        try {
            JSONObject event = new JSONObject(json);
            String type = event.optString("type", "");
            if ("approval.request".equals(type)) {
                // Always worth a buzz: the turn is blocked on a decision.
                notifyApproval(hub,
                        event.optString("approvalId", ""),
                        event.optString("botId", ""),
                        event.optString("botName", ""),
                        event.optString("tool", "工具"),
                        event.optJSONObject("args"),
                        event.optString("reason", ""));
                return;
            }
            if ("approval.resolved".equals(type)) {
                // Decided on the computer or in another client: the phone's card
                // must go away too, or it keeps asking for an answer already given.
                String resolvedId = event.optString("approvalId", "");
                if (!resolvedId.isEmpty()) cancelApprovalNotification(resolvedId);
                return;
            }
            if ("turn.end".equals(type)) {
                // Quiet while the user is already watching that screen.
                if (appVisible) return;
                String status = event.optString("status", "success");
                String summary = event.optString("summary", "");
                String title = "success".equals(status) ? "这一轮做完了" : "这一轮结束了：" + status;
                notify(title, summary.isEmpty() ? "打开 Lamplit 看看结果。" : summary, hub,
                        "", event.optString("botId", ""), event.optString("botName", ""));
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
        service.setDescription("Lamplit 在后台盯着任务。关掉它就不再提醒。");
        service.setShowBadge(false);
        manager.createNotificationChannel(service);

        NotificationChannel events = new NotificationChannel(
                CHANNEL_EVENTS, "任务提醒", NotificationManager.IMPORTANCE_HIGH);
        events.setDescription("任务做完、或者助手在等你确认时提醒你。");
        events.enableVibration(true);
        manager.createNotificationChannel(events);
    }

    /**
     * A tap carries the exact machine the event came from, plus the approval to
     * focus. Request codes must differ per notification: PendingIntent identity
     * ignores extras, so a shared code would make the newest extras win for
     * every notification still on screen.
     */
    private PendingIntent openApp(int requestCode, String hub, String approvalId, String botId) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (hub != null && !hub.isEmpty()) intent.putExtra("desk.openHub", hub);
        if (approvalId != null && !approvalId.isEmpty()) intent.putExtra("desk.openApproval", approvalId);
        if (botId != null && !botId.isEmpty()) intent.putExtra("desk.openBot", botId);
        int pending = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pending |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, requestCode, intent, pending);
    }

    private PendingIntent approvalAction(int requestCode, String hub, String approvalId, String decision, int notificationId) {
        Intent intent = new Intent(this, ApprovalActionReceiver.class);
        intent.setAction(ApprovalActionReceiver.ACTION_DECIDE);
        intent.putExtra(ApprovalActionReceiver.EXTRA_HUB, hub);
        intent.putExtra(ApprovalActionReceiver.EXTRA_APPROVAL_ID, approvalId);
        intent.putExtra(ApprovalActionReceiver.EXTRA_DECISION, decision);
        intent.putExtra(ApprovalActionReceiver.EXTRA_NOTIFICATION_ID, notificationId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(this, requestCode, intent, flags);
    }

    /**
     * The approval notification is a card, not the system template: the same
     * shape as the chat's approval card (kicker, waiting pill, what it wants to
     * do, why it stopped), with the two choices as real buttons. Both buttons
     * post the existing explicit, immutable broadcast to ApprovalActionReceiver,
     * so the device token still never leaves the app's private prefs.
     */
    private void notifyApproval(String hub, String approvalId, String botId, String botName,
                                String tool, JSONObject args, String reason) {
        int id = eventSeq++;
        if (id > 4199) eventSeq = 4110;
        String title = approvalTitle(tool);
        String detail = approvalDetail(tool, args);
        String why = reason == null || reason.trim().isEmpty()
                ? "这一步会改动文件或对外发东西，所以先停下来问你。"
                : "为什么停下来问你：" + reason.trim();

        RemoteViews card = new RemoteViews(getPackageName(), R.layout.notification_approval);
        card.setTextViewText(R.id.notif_kicker,
                botName.isEmpty() ? "需要你确认" : "需要你确认 · " + botName);
        card.setTextViewText(R.id.notif_title, title);
        if (detail.isEmpty()) {
            card.setViewVisibility(R.id.notif_detail, View.GONE);
        } else {
            card.setViewVisibility(R.id.notif_detail, View.VISIBLE);
            card.setTextViewText(R.id.notif_detail_label, approvalDetailLabel(tool));
            card.setTextViewText(R.id.notif_detail_value, detail);
        }
        card.setTextViewText(R.id.notif_why, why);

        PendingIntent open = openApp(id, hub, approvalId, botId);
        card.setOnClickPendingIntent(R.id.notif_card, open);
        card.setOnClickPendingIntent(R.id.notif_title, open);
        card.setOnClickPendingIntent(R.id.notif_detail, open);
        card.setOnClickPendingIntent(R.id.notif_why, open);
        card.setOnClickPendingIntent(R.id.notif_allow,
                approvalAction(id * 2, hub, approvalId, "approve", id));
        card.setOnClickPendingIntent(R.id.notif_deny,
                approvalAction(id * 2 + 1, hub, approvalId, "deny", id));

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_EVENTS)
                : new Notification.Builder(this);
        builder.setContentTitle(botName.isEmpty() ? "需要你确认" : "需要你确认 · " + botName)
                .setContentText(detail.isEmpty() ? title : title + " · " + detail)
                .setSmallIcon(R.drawable.ic_stat_nightshift)
                .setContentIntent(open)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setPriority(Notification.PRIORITY_HIGH)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setCustomBigContentView(card)
                // Its own group: sharing the app's auto group with the foreground
                // service buries the card behind a "Nightshift (2)" bundle, and a
                // collapsed bundle cannot show the two buttons at all.
                .setGroup("nightshift.approval." + approvalId);

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(id, builder.build());
    }

    /** Cancel this approval's card wherever it still sits in the shade. */
    private void cancelApprovalNotification(String approvalId) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        String group = "nightshift.approval." + approvalId;
        StatusBarNotification[] active = manager.getActiveNotifications();
        if (active == null) return;
        for (StatusBarNotification sbn : active) {
            Notification posted = sbn.getNotification();
            if (posted != null && group.equals(posted.getGroup())) manager.cancel(sbn.getId());
        }
    }

    /** Plain-language version of the tool name, mirroring the chat card. */
    private static String approvalTitle(String tool) {
        switch (tool) {
            case "shell": return "想在这台电脑上运行一条命令";
            case "fs_write": return "想写入一个文件";
            case "fs_delete": return "想删除一个文件或文件夹";
            case "fs_mkdir": return "想新建一个文件夹";
            case "fs_read": return "想读取一个文件";
            case "fs_list": return "想看看目录里有什么";
            case "http_fetch": return "想访问一个网址";
            case "browser_open": return "想打开一个网页";
            case "browser_download": return "想下载一个文件";
            case "browser_click": return "想点击网页上的一个位置";
            case "browser_type": return "想在网页里输入文字";
            case "browser_eval": return "想在网页里运行一段脚本";
            case "memory_write": return "想记住一件事";
            case "routine_create": return "想创建一个会自己重复跑的任务";
            case "routine_run": return "想立刻运行一个定时任务";
            case "bot_message": return "想把任务交给另一位助手";
            case "bot_create": return "想新建一个助手";
            case "bot_update": return "想改一个助手的设置";
            case "bot_delete": return "想删除一个助手";
            case "file_send": return "想把一个文件发到另一台机器";
            case "file_fetch": return "想从另一台机器取回一个文件";
            case "machine_switch": return "想把任务交给另一台机器";
            case "image_generate": return "想生成图片";
            case "video_generate": return "想生成一段视频";
            default: return tool.isEmpty() ? "想动一步" : "想使用「" + tool + "」动一步";
        }
    }

    private static String approvalDetailLabel(String tool) {
        switch (tool) {
            case "shell": return "命令";
            case "fs_write":
            case "fs_delete":
            case "fs_mkdir":
            case "fs_read":
            case "fs_list":
            case "file_send":
            case "file_fetch": return "文件";
            case "http_fetch":
            case "browser_open":
            case "browser_download": return "网址";
            case "browser_click": return "目标";
            case "browser_type": return "内容";
            case "browser_eval": return "脚本";
            case "memory_write": return "记住";
            case "routine_create":
            case "bot_message": return "任务";
            case "routine_run": return "任务编号";
            case "machine_switch": return "机器";
            case "image_generate":
            case "video_generate": return "描述";
            default: return "工具";
        }
    }

    /** The one argument that explains the action, capped for the shade. */
    private static String approvalDetail(String tool, JSONObject args) {
        if (args == null) return "";
        String value;
        switch (tool) {
            case "shell": value = args.optString("command", ""); break;
            case "fs_write":
            case "fs_delete":
            case "fs_mkdir":
            case "fs_read":
            case "fs_list":
            case "file_send":
            case "file_fetch": value = args.optString("path", ""); break;
            case "http_fetch":
            case "browser_open":
            case "browser_download": value = args.optString("url", ""); break;
            case "browser_click": value = args.optString("selector", args.optString("ref", args.optString("text", ""))); break;
            case "browser_type": value = args.optString("text", ""); break;
            case "browser_eval": value = args.optString("script", args.optString("code", "")); break;
            case "memory_write": value = args.optString("text", ""); break;
            case "routine_create": value = args.optString("name", args.optString("instruction", "")); break;
            case "routine_run": value = args.optString("id", ""); break;
            case "bot_message": value = args.optString("text", ""); break;
            case "machine_switch": value = args.optString("machine", ""); break;
            case "image_generate":
            case "video_generate": value = args.optString("prompt", ""); break;
            default: value = ""; break;
        }
        value = value.trim();
        if (value.length() > 160) value = value.substring(0, 157) + "…";
        return value;
    }

    private Notification serviceNotification(Context context) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_SERVICE)
                : new Notification.Builder(context);
        builder.setContentTitle("Lamplit 在后台盯着")
                .setContentText("有结果会提醒你")
                .setSmallIcon(R.drawable.ic_stat_nightshift)
                .setContentIntent(openApp(0, null, null, null))
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

    private void notify(String title, String body, String hub, String approvalId, String botId, String botName) {
        int id = eventSeq++;
        if (id > 4199) eventSeq = 4110;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_EVENTS)
                : new Notification.Builder(this);
        builder.setContentTitle(botName.isEmpty() ? title : (title + " · " + botName))
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setSmallIcon(R.drawable.ic_stat_nightshift)
                .setContentIntent(openApp(id, hub, approvalId, botId))
                .setAutoCancel(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            builder.setVisibility(Notification.VISIBILITY_PRIVATE);
        }
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(id, builder.build());
    }
}
