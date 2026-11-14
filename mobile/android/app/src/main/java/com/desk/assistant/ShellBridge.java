package com.desk.assistant;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
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