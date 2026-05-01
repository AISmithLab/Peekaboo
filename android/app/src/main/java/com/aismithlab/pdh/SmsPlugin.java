package com.aismithlab.pdh;

import android.Manifest;
import android.database.Cursor;
import android.net.Uri;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "Sms",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_SMS }, alias = "readSms")
    }
)
public class SmsPlugin extends Plugin {

    @PluginMethod
    public void getMessages(PluginCall call) {
        if (getPermissionState("readSms") != PermissionState.GRANTED) {
            requestPermissionForAlias("readSms", call, "smsPermissionCallback");
            return;
        }
        fetchMessages(call);
    }

    @PermissionCallback
    private void smsPermissionCallback(PluginCall call) {
        if (getPermissionState("readSms") == PermissionState.GRANTED) {
            fetchMessages(call);
        } else {
            call.reject("READ_SMS permission denied");
        }
    }

    private void fetchMessages(PluginCall call) {
        int limit = call.getInt("limit", 100);
        String box = call.getString("box", "inbox");

        Uri uri;
        switch (box) {
            case "sent":  uri = Uri.parse("content://sms/sent");  break;
            case "all":   uri = Uri.parse("content://sms/");      break;
            default:      uri = Uri.parse("content://sms/inbox"); break;
        }

        String[] projection = { "_id", "address", "body", "date", "type", "read" };
        JSArray messages = new JSArray();

        try (Cursor cursor = getContext().getContentResolver().query(
                uri, projection, null, null, "date DESC")) {
            if (cursor != null) {
                int count = 0;
                while (cursor.moveToNext() && count < limit) {
                    JSObject msg = new JSObject();
                    msg.put("id",      cursor.getString(cursor.getColumnIndexOrThrow("_id")));
                    msg.put("address", cursor.getString(cursor.getColumnIndexOrThrow("address")));
                    msg.put("body",    cursor.getString(cursor.getColumnIndexOrThrow("body")));
                    msg.put("date",    cursor.getLong(cursor.getColumnIndexOrThrow("date")));
                    msg.put("type",    cursor.getInt(cursor.getColumnIndexOrThrow("type")));
                    msg.put("read",    cursor.getInt(cursor.getColumnIndexOrThrow("read")) == 1);
                    messages.put(msg);
                    count++;
                }
            }
        } catch (Exception e) {
            call.reject("Failed to read SMS: " + e.getMessage());
            return;
        }

        JSObject result = new JSObject();
        result.put("messages", messages);
        call.resolve(result);
    }
}
