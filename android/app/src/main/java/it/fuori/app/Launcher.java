package it.fuori.app;

import android.Manifest;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.widget.EditText;
import android.widget.Toast;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

/**
 * Apre FUORI a tutto schermo dentro Chrome, come una app vera.
 * All'avvio: permesso degli avvisi, canale di notifica, primo controllo degli avvisi
 * e i due permessi che servono perché arrivino anche a telefono bloccato.
 */
public class Launcher extends LauncherActivity {
  @Override
  protected void onCreate(Bundle stato) {
    super.onCreate(stato);
    try {
      Prefs.device(this);
      Notif.canale(this);
      if (Build.VERSION.SDK_INT >= 33
          && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 41);
      }
      NotifScheduler.subito(this, 4000);
      chiediPosizione();
      chiediBatteria();
      chiediEmail();
    } catch (Throwable t) {
      Toast.makeText(this, "Avvisi: " + t, Toast.LENGTH_LONG).show();
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    try { NotifScheduler.subito(this, 1200); } catch (Throwable t) {}
  }

  /** La posizione serve a FUORI per aggiornare la zona mentre ti muovi. */
  private void chiediPosizione() {
    if (Build.VERSION.SDK_INT < 23) return;
    if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) return;
    requestPermissions(
        new String[] { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, 42);
  }

  /** Senza questa esenzione Android mette l'app in pausa e gli avvisi tardano. */
  private void chiediBatteria() {
    if (Build.VERSION.SDK_INT < 23) return;
    if (Prefs.chiestoBatteria(this)) return;
    Prefs.chiestoBatteria(this, true);
    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
    if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
    try {
      Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
      startActivity(i);
    } catch (Throwable t) {}
  }

  /** L'email serve solo per gli avvisi dei TUOI eventi (inviti e messaggi). */
  private void chiediEmail() {
    if (Prefs.chiestoEmail(this)) return;
    Prefs.chiestoEmail(this, true);
    EditText campo = new EditText(this);
    campo.setInputType(InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
    campo.setHint("la tua email");
    new AlertDialog.Builder(this)
        .setTitle("Avvisi con l'icona di FUORI")
        .setMessage("Scrivi l'email che usi su FUORI: così gli avvisi dei tuoi eventi arrivano dall'app, anche a telefono bloccato. Se la lasci vuota ricevi comunque gli eventi della zona.")
        .setView(campo)
        .setPositiveButton("Salva", (d, w) -> {
          String e = campo.getText().toString().trim().toLowerCase();
          if (e.contains("@") && e.contains(".")) {
            Prefs.email(this, e);
            Toast.makeText(this, "Fatto: gli avvisi ora arrivano dall'app", Toast.LENGTH_SHORT).show();
          }
          NotifScheduler.subito(this, 1500);
        })
        .setNegativeButton("Dopo", (d, w) -> NotifScheduler.subito(this, 1500))
        .show();
  }
}
