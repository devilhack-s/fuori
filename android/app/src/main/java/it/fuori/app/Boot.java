package it.fuori.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Dopo un riavvio o un aggiornamento dell'app, gli avvisi riprendono da soli. */
public class Boot extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    Context app = context.getApplicationContext();
    NotifScheduler.subito(app, 30 * 1000L);
  }
}
