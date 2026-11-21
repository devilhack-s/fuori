package it.fuori.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Un promemoria ogni quarto d'ora: è il massimo che Android concede senza consumare batteria. */
final class NotifScheduler {
  private static final int ID = 7;

  static void subito(Context c, long fraMs) {
    AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
    if (am == null) return;
    PendingIntent pi = intento(c);
    long quando = System.currentTimeMillis() + fraMs;
    try {
      if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, quando, pi);
      else am.set(AlarmManager.RTC_WAKEUP, quando, pi);
    } catch (Throwable t) {
      // se Android non lascia, riprovo con la sveglia semplice
      try { am.set(AlarmManager.RTC_WAKEUP, quando, pi); } catch (Throwable t2) {}
    }
  }

  static void riarma(Context c) {
    subito(c, 15 * 60 * 1000L);
  }

  private static PendingIntent intento(Context c) {
    Intent i = new Intent(c, NotifCheck.class);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
    return PendingIntent.getBroadcast(c, ID, i, flags);
  }
}
