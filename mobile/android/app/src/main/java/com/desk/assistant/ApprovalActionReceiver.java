package com.desk.assistant;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * The 批准/拒绝 buttons on an approval notification.
 *
 * The whole point is answering without opening the app, so the tap goes to an
 * explicit receiver that makes one short POST to the hub and finishes. The
 * device token never leaves the private preferences: it is read here, used in
 * the request header, and never put on the intent.
 *
 * If the request cannot be delivered the notification is replaced by one that
 * opens the approval card, because the human still has to decide - silently
 * losing an answer would be worse than asking twice.
 */
public class ApprovalActionReceiver extends BroadcastReceiver {

    private static final String TAG = "nightshift-decide";

    static final String ACTION_DECIDE = "com.desk.assistant.action.DECIDE_APPROVAL";
    static final String EXTRA_HUB = "hub";
    static final String EXTRA_APPROVAL_ID = "approvalId";
    static final String EXTRA_DECISION = "decision";
    static final String EXTRA_NOTIFICATION_ID = "notificationId";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_DECIDE.equals(intent.getAction())) return;
        final String hub = trim(intent.getStringExtra(EXTRA_HUB));
        final String approvalId = trim(intent.getStringExtra(EXTRA_APPROVAL_ID));
        final String decision = trim(intent.getStringExtra(EXTRA_DECISION));
        final int notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0);
        if (hub.isEmpty() || approvalId.isEmpty() || decision.isEmpty()) return;

        final Context app = context.getApplicationContext();
        final PendingResult pending = goAsync();
        new Thread(() -> {
            String problem;
            try {
                problem = decide(app, hub, approvalId, decision);
            } catch (Exception err) {
                problem = err.getClass().getSimpleName();
            }
            NotificationManager manager = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            try {
                if (manager != null) {
                    if (problem == null) manager.cancel(notificationId);
                    else manager.notify(notificationId, fallback(app, hub, approvalId, problem));
                }
            } finally {
                pending.finish();
            }
        }, "nightshift-decide").start();
    }

    /** POST the decision; null on success (or when it was already resolved). */
    private String decide(Context context, String hub, String approvalId, String decision) {
        SharedPreferences prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String token = prefs.getString("desk.token:" + hub, null);
        if (token == null || token.isEmpty()) return "这个电脑的配对已经失效";

        HttpURLConnection conn = null;
        try {
            URL url = new URL(hub + "/api/approvals/" + Uri.encode(approvalId));
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);

            JSONObject body = new JSONObject();
            body.put("decision", decision);
            body.put("note", "手机通知");
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            OutputStream out = conn.getOutputStream();
            out.write(payload);
            out.close();

            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in != null) {
                ByteArrayOutputStream sink = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                int read;
                while ((read = in.read(buffer)) > 0) sink.write(buffer, 0, read);
                in.close();
            }
            if (status == 200) return null;
            // Gone or already answered: the card is history, do not nag.
            if (status == 404 || status == 409) {
                Log.i(TAG, "approval " + approvalId + " already resolved (" + status + ")");
                return null;
            }
            if (status == 401) return "手机上的配对令牌失效了";
            return "电脑回了 HTTP " + status;
        } catch (Exception err) {
            Log.i(TAG, "decision not delivered: " + err.getClass().getSimpleName());
            return "没连上电脑";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private Notification fallback(Context context, String hub, String approvalId, String problem) {
        NightshiftWatcher.createChannels(context);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, "nightshift-events")
                : new Notification.Builder(context);
        Intent open = new Intent(context, MainActivity.class);
        open.setAction(Intent.ACTION_MAIN);
        open.addCategory(Intent.CATEGORY_LAUNCHER);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("desk.openHub", hub);
        open.putExtra("desk.openApproval", approvalId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent tap = PendingIntent.getActivity(context, 9, open, flags);
        builder.setContentTitle("这一步还没答复")
                .setContentText(problem + "，点开自己确认一下。")
                .setStyle(new Notification.BigTextStyle().bigText(problem + "，点开自己确认一下。"))
                .setSmallIcon(R.drawable.ic_stat_nightshift)
                .setContentIntent(tap)
                .setAutoCancel(true);
        return builder.build();
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }
}
