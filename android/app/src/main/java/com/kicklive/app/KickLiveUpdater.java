package com.kicklive.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "KickLiveUpdater")
public class KickLiveUpdater extends Plugin {
    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String urlString = call.getString("url", "");
        if (urlString.isEmpty() || !urlString.startsWith("https://")) {
            call.reject("Only secure HTTPS APK URLs are allowed");
            return;
        }

        new Thread(() -> {
            File apk = null;
            try {
                apk = downloadApk(urlString);
                Uri apkUri = FileProvider.getUriForFile(
                    getContext(), getContext().getPackageName() + ".fileprovider", apk
                );
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                JSObject result = new JSObject();
                result.put("started", true);
                call.resolve(result);
            } catch (Exception error) {
                if (apk != null) apk.delete();
                call.reject(error.getMessage() == null ? "APK update failed" : error.getMessage());
            }
        }).start();
    }

    private File downloadApk(String urlString) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(urlString).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(120000);
        connection.setInstanceFollowRedirects(true);
        connection.connect();
        if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
            throw new Exception("APK download failed: HTTP " + connection.getResponseCode());
        }

        File apk = new File(getContext().getCacheDir(), "kicklive-update.apk");
        try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(apk)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        } finally {
            connection.disconnect();
        }
        return apk;
    }
}
