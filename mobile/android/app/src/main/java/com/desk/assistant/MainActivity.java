package com.desk.assistant;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * Nightshift's Android shell.
 *
 * The WebView loads the hub's own UI at the top level (that is what makes the
 * hub's HttpOnly SameSite=Lax session cookie work), so the Android back button
 * would otherwise close the app while the user is looking at the hub - with no
 * way back to "change hub".
 *
 * Rule: if the WebView is showing anything other than the local shell, back goes
 * back to the shell. On the shell itself, back behaves normally (exits the app).
 *
 * It also starts the background watcher: once this phone is paired, a foreground
 * service holds the hub's event stream so notifications arrive with the screen
 * off (see NightshiftWatcher).
 */
public class MainActivity extends BridgeActivity {

    private static final int REQ_NOTIFICATIONS = 71;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        startWatcher();
        askForNotifications();
        openFromNotification(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openFromNotification(intent);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // BridgeActivity keeps the lifecycle hooks final, and focus is exactly
        // what matters here: the user is looking at this window right now.
        NightshiftWatcher.appVisible = hasFocus;
    }

    /**
     * A notification tap carries the machine the event came from, and for an
     * approval the exact card to land on - otherwise a phone paired with two
     * computers would open the wrong one (or the picker) and the tap would be
     * useless exactly when the turn is blocked.
     */
    private void openFromNotification(Intent intent) {
        if (intent == null) return;
        String hub = intent.getStringExtra("desk.openHub");
        String approvalId = intent.getStringExtra("desk.openApproval");
        String botId = intent.getStringExtra("desk.openBot");
        if (hub == null || hub.isEmpty()) return;
        intent.removeExtra("desk.openHub");
        intent.removeExtra("desk.openApproval");
        intent.removeExtra("desk.openBot");
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) return;
        final String url = hubWithTarget(hub, approvalId, botId);
        bridge.getWebView().postDelayed(() -> {
            String current = bridge.getWebView().getUrl();
            // Exact match: the same hub with a different approval is a different
            // destination, and startsWith would skip the load.
            if (current == null || !current.equals(url)) bridge.getWebView().loadUrl(url);
        }, 350);
    }

    /** hub root, plus the approval the tap came from (when there is one). */
    private String hubWithTarget(String hub, String approvalId, String botId) {
        String base = hub.endsWith("/") ? hub : hub + "/";
        if (approvalId == null || approvalId.isEmpty()) return base;
        StringBuilder url = new StringBuilder(base)
                .append("?approval=").append(android.net.Uri.encode(approvalId));
        if (botId != null && !botId.isEmpty()) url.append("&bot=").append(android.net.Uri.encode(botId));
        return url.toString();
    }

    /** Ask once (Android 13+); a denial just means quiet, never a crash. */
    private void askForNotifications() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFICATIONS);
    }

    private void startWatcher() {
        if (!NightshiftWatcher.hasPairing(this)) return;
        Intent intent = new Intent(this, NightshiftWatcher.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent);
            else startService(intent);
        } catch (Exception err) {
            // A blocked start (battery saver, OEM restrictions) must not take the
            // app down: the UI still works, it just will not wake the user.
            android.util.Log.w("nightshift", "watcher not started: " + err.getMessage());
        }
    }

    @Override
    @SuppressWarnings("deprecation") // onBackPressed is still the supported hook for API < 33
    public void onBackPressed() {
        Bridge current = getBridge();
        if (current != null) {
            WebView webView = current.getWebView();
            String shellUrl = current.getLocalUrl();
            String currentUrl = webView != null ? webView.getUrl() : null;

            boolean onShell = currentUrl == null || shellUrl == null || currentUrl.startsWith(shellUrl);
            if (!onShell && shellUrl != null) {
                webView.loadUrl(shellUrl);
                return;
            }
        }
        super.onBackPressed();
    }
}
