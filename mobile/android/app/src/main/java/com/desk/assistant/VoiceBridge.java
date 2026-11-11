package com.desk.assistant;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.File;
import java.nio.file.Files;

/**
 * Records microphone audio for the hub page.
 *
 * The hub is usually reached over plain http on the LAN, which is not a secure
 * context: the page cannot call getUserMedia there. The page already has a
 * fallback for exactly this case (the desktop shell records for it), so this
 * bridge offers the same three calls over a JavascriptInterface and the shell
 * injects a tiny adapter that maps them onto window.desk.
 */
public class VoiceBridge {

    private static final int REQ_AUDIO = 72;

    private final Activity activity;
    private MediaRecorder recorder;
    private File file;

    public VoiceBridge(Activity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String start() {
        if (recorder != null) return ok();
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            activity.runOnUiThread(() ->
                    activity.requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_AUDIO));
            return "{\"ok\":false,\"error\":\"Pending\",\"message\":\"请在弹窗里允许麦克风，然后再点一次\"}";
        }
        try {
            file = new File(activity.getCacheDir(), "voice-input.m4a");
            recorder = new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioEncodingBitRate(96000);
            recorder.setAudioSamplingRate(44100);
            recorder.setOutputFile(file.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            return ok();
        } catch (Exception err) {
            release();
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String stop() {
        if (recorder == null) return "null";
        try {
            recorder.stop();
        } catch (RuntimeException err) {
            // stop() throws when nothing was captured (a tap, not a sentence).
            release();
            return "null";
        }
        release();
        try {
            byte[] bytes = Files.readAllBytes(file.toPath());
            file.delete();
            JSONObject out = new JSONObject();
            out.put("mime", "audio/mp4");
            out.put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            return out.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String cancel() {
        if (recorder != null) {
            try {
                recorder.stop();
            } catch (RuntimeException ignored) {
                // nothing captured
            }
            release();
        }
        if (file != null) file.delete();
        return ok();
    }

    private void release() {
        if (recorder != null) {
            recorder.release();
            recorder = null;
        }
    }

    private String ok() {
        return "{\"ok\":true}";
    }

    private String error(String message) {
        try {
            JSONObject out = new JSONObject();
            out.put("ok", false);
            out.put("error", "Error");
            out.put("message", message == null ? "recorder failed" : message);
            return out.toString();
        } catch (Exception err) {
            return "{\"ok\":false,\"error\":\"Error\"}";
        }
    }
}