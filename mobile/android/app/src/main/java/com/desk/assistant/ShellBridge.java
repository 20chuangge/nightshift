package com.desk.assistant;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.view.Window;
import android.webkit.JavascriptInterface;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

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
}