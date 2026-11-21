package it.fuori.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.os.Build;
import android.provider.Settings;

import com.google.androidbrowserhelper.locationdelegation.LocationDelegationExtraCommandHandler;
import com.google.androidbrowserhelper.trusted.DelegationService;

/**
 * Chrome, quando FUORI è installata, gli passa gli avvisi del sito.
 * Qui li ripubblichiamo sul canale dell'app: nome FUORI, suono e vibrazione.
 */
public class FuoriDelegationService extends DelegationService {
  @Override
  public void onCreate() {
    super.onCreate();
    // senza questo Chrome non riceve la posizione dall'app e resta sull'ultima
    registerExtraCommandHandler(new LocationDelegationExtraCommandHandler());
  }

  @Override
  public boolean onNotifyNotificationWithChannel(String tag, int id, Notification notification, String channelName) {
    if (Build.VERSION.SDK_INT < 23) return super.onNotifyNotificationWithChannel(tag, id, notification, channelName);
    try {
      Notif.canale(this);
      NotificationManager m = getSystemService(NotificationManager.class);
      if (m == null) return super.onNotifyNotificationWithChannel(tag, id, notification, channelName);
      Notification.Builder b = Notification.Builder.recoverBuilder(this, notification);
      b.setSmallIcon(R.drawable.ic_notifica);
      b.setAutoCancel(true);
      b.setCategory(Notification.CATEGORY_EVENT);
      b.setVisibility(Notification.VISIBILITY_PUBLIC);
      if (Build.VERSION.SDK_INT >= 26) {
        b.setChannelId(Notif.CANALE);
      } else {
        b.setDefaults(Notification.DEFAULT_ALL);
        b.setVibrate(Notif.VIBRA);
        b.setSound(Settings.System.DEFAULT_NOTIFICATION_URI);
        b.setPriority(Notification.PRIORITY_MAX);
      }
      m.notify(tag, id, b.build());
      return true;
    } catch (Throwable ignored) {
      return super.onNotifyNotificationWithChannel(tag, id, notification, channelName);
    }
  }
}
