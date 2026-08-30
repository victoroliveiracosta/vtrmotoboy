package com.vtrpdv.motoboy;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Ponte entre o JavaScript do app (www/app.js) e o LocationTrackingService
 * nativo - é essa ponte que o app chama quando o entregador fica "online"
 * (startTracking) ou "offline" (stopTracking).
 *
 * Substitui o @capacitor-community/background-geolocation antigo, que não
 * estava mandando localização de forma confiável com o app minimizado ou
 * a tela apagada. Esse plugin usa um Foreground Service escrito na mão
 * (LocationTrackingService), sem depender de nenhuma biblioteca de
 * terceiro pra parte de rastreio em si.
 *
 * A notificação de "entrega nova" NÃO é mostrada por aqui - ela é
 * construída direto dentro do LocationTrackingService (que faz sua
 * própria checagem periódica de entregas, independente do app estar
 * aberto/minimizado/com a tela apagada). Ver checarEntregasNovas() lá.
 * Esse plugin só cuida das permissões (localização e notificação) e de
 * ligar/desligar o serviço.
 */
@CapacitorPlugin(
    name = "LocationTracking",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "backgroundLocation", strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class LocationTrackingPlugin extends Plugin {

    @PluginMethod()
    public void checkPermissions(PluginCall call) {
        JSObject resultado = new JSObject();
        resultado.put("location", getPermissionState("location").toString());
        // Antes do Android 10 (Q), essa permissão separada nem existe -
        // trata como "já ok" nesse caso.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            resultado.put("backgroundLocation", getPermissionState("backgroundLocation").toString());
        } else {
            resultado.put("backgroundLocation", "granted");
        }
        // Antes do Android 13 (TIRAMISU) não existe permissão de
        // notificação nenhuma pra pedir - qualquer notificação já pode
        // aparecer direto, então trata como "já concedida" pra não
        // confundir a tela com um estado que nem existe nessa versão.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            resultado.put("notifications", getPermissionState("notifications").toString());
        } else {
            resultado.put("notifications", "granted");
        }
        call.resolve(resultado);
    }

    @PluginMethod()
    public void requestPermissions(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermsCallback");
        } else {
            locationPermsCallback(call);
        }
    }

    @PermissionCallback
    private void locationPermsCallback(PluginCall call) {
        // Localização "enquanto usa o app" respondida (concedida ou não) -
        // devolve o resultado. A permissão de segundo plano é pedida À
        // PARTE (ver requestBackgroundPermission), porque o Android EXIGE
        // que ela seja solicitada separadamente, só depois da localização
        // normal já estar concedida - pedir as duas juntas faz o sistema
        // rejeitar a solicitação inteira.
        checkPermissions(call);
    }

    @PluginMethod()
    public void requestBackgroundPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            checkPermissions(call);
            return;
        }
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Precisa liberar a localização normal primeiro.");
            return;
        }
        requestPermissionForAlias("backgroundLocation", call, "backgroundLocationCallback");
    }

    @PermissionCallback
    private void backgroundLocationCallback(PluginCall call) {
        checkPermissions(call);
    }

    // Mostra (se necessário) a caixinha do sistema pedindo permissão de
    // notificação (POST_NOTIFICATIONS) - só existe/só faz algo a partir
    // do Android 13. Chamado UMA VEZ, logo depois do login (ver
    // pedirPermissaoNotificacao em www/app.js), pra já aparecer sozinho
    // na primeira abertura do app, em vez do entregador precisar entrar
    // manualmente em Configurações pra ativar. Se ele já concedeu antes,
    // ou já negou "não perguntar de novo", o Android nem mostra nada e
    // isso só devolve o estado atual na hora.
    @PluginMethod()
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject resultado = new JSObject();
            resultado.put("granted", true);
            call.resolve(resultado);
            return;
        }
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject resultado = new JSObject();
            resultado.put("granted", true);
            call.resolve(resultado);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermCallback");
    }

    @PermissionCallback
    private void notificationPermCallback(PluginCall call) {
        JSObject resultado = new JSObject();
        resultado.put("granted", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(resultado);
    }

    // A PARTIR DO ANDROID 11, o próprio Android não mostra mais a opção
    // "Permitir o tempo todo" em NENHUMA caixinha de permissão (mesmo
    // chamando requestBackgroundPermission acima) - a única forma de
    // conseguir essa opção é abrindo a tela de permissões do app
    // manualmente. Esse método leva a pessoa direto pra lá.
    @PluginMethod()
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod()
    public void isGpsEnabled(PluginCall call) {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        boolean ativado = lm != null && (lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER));
        JSObject resultado = new JSObject();
        resultado.put("enabled", ativado);
        call.resolve(resultado);
    }

    @PluginMethod()
    public void startTracking(PluginCall call) {
        String token = call.getString("token");
        String apiBase = call.getString("apiBase", "https://vtrpdv.com/api");

        if (token == null || token.isEmpty()) {
            call.reject("Token do entregador não informado.");
            return;
        }
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Sem permissão de localização.");
            return;
        }

        Context contexto = getContext();
        Intent intent = new Intent(contexto, LocationTrackingService.class);
        intent.setAction(LocationTrackingService.ACAO_INICIAR);
        intent.putExtra(LocationTrackingService.EXTRA_TOKEN, token);
        intent.putExtra(LocationTrackingService.EXTRA_API_BASE, apiBase);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(contexto, intent);
        } else {
            contexto.startService(intent);
        }

        // Lembra que o entregador está "online" - sobrevive o app ser
        // fechado/reaberto, é assim que a tela sabe se deve mostrar o
        // botão "Ficar online" ou "Ficar offline" quando reabre.
        SharedPreferences prefs = contexto.getSharedPreferences("vtr_entregador_prefs", Context.MODE_PRIVATE);
        prefs.edit().putBoolean("online", true).apply();

        call.resolve();
    }

    @PluginMethod()
    public void stopTracking(PluginCall call) {
        Context contexto = getContext();
        Intent intent = new Intent(contexto, LocationTrackingService.class);
        intent.setAction(LocationTrackingService.ACAO_PARAR);
        contexto.startService(intent);

        SharedPreferences prefs = contexto.getSharedPreferences("vtr_entregador_prefs", Context.MODE_PRIVATE);
        prefs.edit().putBoolean("online", false).apply();

        call.resolve();
    }

    @PluginMethod()
    public void isTrackingOnline(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences("vtr_entregador_prefs", Context.MODE_PRIVATE);
        JSObject resultado = new JSObject();
        resultado.put("online", prefs.getBoolean("online", false));
        call.resolve(resultado);
    }
}
