package it.fuori.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.UUID;

/** Le poche cose che l'app ricorda da sola: chi è il telefono e con quale email. */
final class Prefs {
  private static SharedPreferences p(Context c) {
    return c.getSharedPreferences("fuori", Context.MODE_PRIVATE);
  }

  static String device(Context c) {
    SharedPreferences s = p(c);
    String d = s.getString("device", "");
    if (d == null || d.length() < 8) {
      d = UUID.randomUUID().toString();
      s.edit().putString("device", d).apply();
    }
    return d;
  }

  static String email(Context c) {
    return p(c).getString("email", "");
  }

  static void email(Context c, String e) {
    p(c).edit().putString("email", e == null ? "" : e.trim().toLowerCase()).apply();
  }

  static boolean chiestoBatteria(Context c) {
    return p(c).getBoolean("chiestoBatteria", false);
  }

  static void chiestoBatteria(Context c, boolean v) {
    p(c).edit().putBoolean("chiestoBatteria", v).apply();
  }

  static boolean chiestoEmail(Context c) {
    return p(c).getBoolean("chiestoEmail", false);
  }

  static void chiestoEmail(Context c, boolean v) {
    p(c).edit().putBoolean("chiestoEmail", v).apply();
  }
}
