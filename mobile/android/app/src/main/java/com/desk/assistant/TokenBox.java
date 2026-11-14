package com.desk.assistant;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Device tokens at rest (SEC-16).
 *
 * Each paired machine's session token lives in SharedPreferences
 * ("CapacitorStorage", key desk.token:<hub>). Stored as "tb1:" + base64(iv|data),
 * AES-256-GCM with a key that never leaves the Android Keystore: a copy of the
 * app's files (a backup, a rooted dump) holds no usable token. A value without
 * the prefix is a token from before; it is read as it is and sealed on next use.
 */
public final class TokenBox {

    private static final String ALIAS = "lamplit_device_tokens";
    private static final String PREFIX = "tb1:";
    private static final int IV_BYTES = 12;

    private TokenBox() {
    }

    private static synchronized SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return gen.generateKey();
    }

    /** The sealed form of a token, or null when the Keystore is unavailable (the caller keeps what it had). */
    public static String seal(String plain) {
        if (plain == null) return null;
        if (plain.startsWith(PREFIX)) return plain;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] data = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + data.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(data, 0, out, iv.length, data.length);
            String sealed = PREFIX + Base64.encodeToString(out, Base64.NO_WRAP);
            // Never hand back something this phone cannot open again.
            return plain.equals(open(sealed)) ? sealed : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** The token itself: a sealed value opened, a plain one (from before) as it is; null when it cannot be opened. */
    public static String open(String stored) {
        if (stored == null) return null;
        if (!stored.startsWith(PREFIX)) return stored;
        try {
            byte[] all = Base64.decode(stored.substring(PREFIX.length()), Base64.NO_WRAP);
            if (all.length <= IV_BYTES) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, IV_BYTES));
            return new String(cipher.doFinal(all, IV_BYTES, all.length - IV_BYTES), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}
