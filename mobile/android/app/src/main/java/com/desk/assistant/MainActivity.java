package com.desk.assistant;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

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
        installVoiceBridge();
        openFromNotification(getIntent());
    }

    /**
     * The hub page is normally plain http on the LAN, where getUserMedia does not
     * exist. The page already knows how to let the shell record for it
     * (window.desk.voiceStart/Stop/Cancel, the desktop path); offer the same
     * three calls from Android and adapt them onto window.desk after each load.
     */
    private void installVoiceBridge() {
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) return;
        WebView webView = bridge.getWebView();
        webView.addJavascriptInterface(new VoiceBridge(this), "NightshiftVoice");
        webView.addJavascriptInterface(new ShellBridge(this), "NightshiftShell");
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                view.evaluateJavascript(VOICE_SHIM, null);
            }
        });
    }

    private static final String VOICE_SHIM = "(function(){"
            + "var n=window.NightshiftVoice,s=window.NightshiftShell;"
            + "var d=window.desk=window.desk||{};"
            + "d.setImmersive=function(on){try{if(s)s.setImmersive(!!on);}catch(e){}};"
            + "d.setOrientation=function(mode){try{if(s)s.setOrientation(String(mode||'portrait'));}catch(e){}};"
            + "if(s&&s.clipboardRead){d.clipboardRead=async function(){return String(s.clipboardRead()||'');};"
            + "d.clipboardWrite=async function(t){return !!s.clipboardWrite(String(t==null?'':t));};}"
            + "if(s&&s.openExternal){d.openExternal=async function(u){return !!s.openExternal(String(u||''));};}"
            + "if(!n||d.voiceStart)return;"
            + "var parse=function(x){try{return JSON.parse(x);}catch(e){return null;}};"
            + "d.voiceStart=async function(){return parse(n.start())||{error:'Error'};};"
            + "d.voiceStop=async function(){var o=parse(n.stop());if(!o||!o.b64)return null;"
            + "var b=atob(o.b64),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);"
            + "return {mime:o.mime,bytes:a};};"
            + "d.voiceCancel=async function(){n.cancel();return true;};"
            + "})();";

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
