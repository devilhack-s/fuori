package it.fuori.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * Si sveglia da solo, chiede al server se ci sono avvisi nuovi e li mostra con
 * l'icona dell'app. Funziona anche con l'app chiusa, lo schermo spento o dopo un riavvio.
 */
public class NotifCheck extends BroadcastReceiver {
  private static final String BASE = "https://fuori.fuori-catania.workers.dev/api/appnotif";

  @Override
  public void onReceive(Context context, Intent intent) {
    final PendingResult esito = goAsync();
    final Context app = context.getApplicationContext();
    new Thread(() -> {
      try {
        controlla(app);
      } catch (Throwable t) {
        Log.w("FUORI", "avvisi: " + t);
      } finally {
        NotifScheduler.riarma(app);
        esito.finish();
      }
    }).start();
  }

  static int controlla(Context c) {
    HttpURLConnection con = null;
    try {
      String url = BASE + "?d=" + URLEncoder.encode(Prefs.device(c), "UTF-8");
      String email = Prefs.email(c);
      if (!email.isEmpty()) url += "&email=" + URLEncoder.encode(email, "UTF-8");
      con = (HttpURLConnection) new URL(url).openConnection();
      con.setConnectTimeout(12000);
      con.setReadTimeout(15000);
      con.setRequestProperty("User-Agent", "FUORI-app");
      if (con.getResponseCode() != 200) return 0;
      StringBuilder sb = new StringBuilder();
      BufferedReader r = new BufferedReader(new InputStreamReader(con.getInputStream(), "UTF-8"));
      String riga;
      while ((riga = r.readLine()) != null) sb.append(riga);
      r.close();
      JSONArray items = new JSONObject(sb.toString()).optJSONArray("items");
      if (items == null) return 0;
      int quanti = 0;
      for (int i = 0; i < items.length(); i++) {
        JSONObject o = items.getJSONObject(i);
        String titolo = o.optString("title", "FUORI");
        String testo = o.optString("body", "");
        String id = o.optString("id", "" + i);
        Notif.mostra(c, titolo, testo, Math.abs(id.hashCode()));
        quanti++;
      }
      return quanti;
    } catch (Throwable t) {
      return 0;
    } finally {
      if (con != null) con.disconnect();
    }
  }
}
