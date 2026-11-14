package com.desk.assistant;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import java.util.Map;
import android.content.pm.ActivityInfo;
import android.view.Window;
import android.webkit.JavascriptInterface;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/**
 * Native window control for the takeover view.
 *
 * The hub page is a remote URL, so Capacitor's plugin JS bridge is not injected
 * there; these two calls are the same intent the screen-orientation plugin
 * carries, exposed directly to the page.
 */
public class ShellBridge {

    private final Activity activity;

    public ShellBridge(Activity activity) {
        this.activity = activity;
    }

    /*
     * Who is calling (SEC-16). Every page the app shows gets this bridge, and
     * the app may show any address a link leads to. The clipboard is for the
     * app's own page and the machines this phone is paired with; the token box
     * is for the app's own page only (the launcher, http://localhost).
     */
    private String currentUrl() {
        FutureTask<String> task = new FutureTask<>(() -> {
            if (!(activity instanceof BridgeActivity)) return "";
            WebView view = ((BridgeActivity) activity).getBridge().getWebView();
            String url = view == null ? null : view.getUrl();
            return url == null ? "" : url;
        });
        activity.runOnUiThread(task);
        try {
            return task.get(3, TimeUnit.SECONDS);
        } catch (Exception e) {
            return "";
        }
    }

    private static String originOf(String url) {
        try {
            Uri u = Uri.parse(url);
            if (u.getScheme() == null || u.getHost() == null) return "";
            return u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        } catch (Exception e) {
            return "";
        }
    }

    boolean fromAppPage() {
        return "http://localhost".equals(originOf(currentUrl()));
    }

    boolean fromTrustedPage() {
        String origin = originOf(currentUrl());
        if (origin.isEmpty()) return false;
        if ("http://localhost".equals(origin)) return true;
        SharedPreferences p = activity.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        for (Map.Entry<String, ?> entry : p.getAll().entrySet()) {
            String key = entry.getKey();
            if (key.startsWith("desk.token:") && origin.equals(originOf(key.substring("desk.token:".length())))) return true;
        }
        return false;
    }

    /** A device token sealed with the phone's Keystore (launcher only). Empty when sealing is not possible. */
    @JavascriptInterface
    public String sealToken(final String token) {
        if (!fromAppPage()) return "";
        String sealed = TokenBox.seal(token);
        return sealed == null ? "" : sealed;
    }

    /** The token inside a sealed value (launcher only). Empty when it cannot be opened. */
    @JavascriptInterface
    public String openToken(final String sealed) {
        if (!fromAppPage()) return "";
        String token = TokenBox.open(sealed);
        return token == null ? "" : token;
    }

    @JavascriptInterface
    public void setImmersive(final boolean on) {
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            WindowCompat.setDecorFitsSystemWindows(window, !on);
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            if (controller == null) return;
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            if (on) controller.hide(WindowInsetsCompat.Type.systemBars());
            else controller.show(WindowInsetsCompat.Type.systemBars());
        });
    }

    @JavascriptInterface
    public void setOrientation(final String mode) {
        activity.runOnUiThread(() -> {
            int requested;
            if ("landscape".equals(mode)) requested = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
            else if ("portrait".equals(mode)) requested = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
            else requested = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
            activity.setRequestedOrientation(requested);
        });
    }

    /*
     * The phone's clipboard. The hub page is plain http on the LAN, where
     * navigator.clipboard does not exist; ClipboardManager is the system's own
     * and carries any text (Chinese included). Read and written on the UI
     * thread: Android 10+ only lets the app in focus read it.
     */
    @JavascriptInterface
    public String clipboardRead() {
        if (!fromTrustedPage()) return "";
        FutureTask<String> task = new FutureTask<>(() -> {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence text = clip.getItemAt(0).coerceToText(activity);
            return text == null ? "" : text.toString();
        });
        activity.runOnUiThread(task);
        try {
            return task.get(3, TimeUnit.SECONDS);
        } catch (Exception e) {
            return "";
        }
    }

    /*
     * A sign-in page (a connected app's OAuth) in the phone's browser: the
     * app's page comes back to the machine's address, which the browser reaches
     * the same way this app does.
     */
    @JavascriptInterface
    public boolean openExternal(final String url) {
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return false;
        activity.runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(intent);
            } catch (Exception ignored) {
                // no browser: the page shows a link to copy
            }
        });
        return true;
    }

    @JavascriptInterface
    public boolean clipboardWrite(final String text) {
        if (!fromTrustedPage()) return false;
        FutureTask<Boolean> task = new FutureTask<>(() -> {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return false;
            cm.setPrimaryClip(ClipData.newPlainText("Lamplit", text == null ? "" : text));
            return true;
        });
        activity.runOnUiThread(task);
        try {
            return task.get(3, TimeUnit.SECONDS);
        } catch (Exception e) {
            return false;
        }
    }
}