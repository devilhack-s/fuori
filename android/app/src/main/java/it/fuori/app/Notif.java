package it.fuori.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.os.Build;
import android.provider.Settings;

/** Gli avvisi li mette l'app, non Chrome: icona e nome sono quelli di FUORI. */
final class Notif {
  // canale nuovo: quello vecchio poteva essere rimasto silenzioso nelle impostazioni Android
  static final String CANALE = "fuori-avvisi-v2";
  static final long[] VIBRA = new long[] { 0, 350, 180, 350 };

  static void canale(Context c) {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager m = c.getSystemService(NotificationManager.class);
    if (m == null) return;
    // tolgo il canale vecchio, così non porta dietro il silenzio
    try { m.deleteNotificationChannel("fuori-avvisi"); } catch (Throwable ignored) {}
    NotificationChannel ch = new NotificationChannel(CANALE, "Avvisi FUORI", NotificationManager.IMPORTANCE_HIGH);
    ch.setDescription("Eventi, inviti e messaggi di FUORI");
    ch.setShowBadge(true);
    ch.enableVibration(true);
    ch.setVibrationPattern(VIBRA);
    ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    AudioAttributes audio = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build();
    ch.setSound(Settings.System.DEFAULT_NOTIFICATION_URI, audio);
    m.createNotificationChannel(ch);
  }

  static void mostra(Context c, String titolo, String testo, int id) {
    canale(c);
    NotificationManager m = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
    if (m == null) return;

    Intent apri = new Intent(c, Launcher.class);
    apri.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent pi = PendingIntent.getActivity(c, id, apri, flags);

    Notification.Builder b = Build.VERSION.SDK_INT >= 26
        ? new Notification.Builder(c, CANALE)
        : new Notification.Builder(c);
    b.setContentTitle(titolo)
        .setContentText(testo)
        .setStyle(new Notification.BigTextStyle().bigText(testo))
        .setSmallIcon(R.drawable.ic_notifica)
        .setLargeIcon(BitmapFactory.decodeResource(c.getResources(), R.mipmap.ic_launcher))
        .setContentIntent(pi)
        .setAutoCancel(true)
        .setShowWhen(true)
        .setCategory(Notification.CATEGORY_EVENT)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setWhen(System.currentTimeMillis());
    if (Build.VERSION.SDK_INT < 26) {
      b.setPriority(Notification.PRIORITY_MAX);
      b.setDefaults(Notification.DEFAULT_ALL);
      b.setVibrate(VIBRA);
      b.setSound(Settings.System.DEFAULT_NOTIFICATION_URI);
    }
    m.notify(id, b.build());
  }
}
