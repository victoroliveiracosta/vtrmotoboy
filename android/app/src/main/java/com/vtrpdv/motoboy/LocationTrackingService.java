package com.vtrpdv.motoboy;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Serviço de rastreamento de localização do entregador - TOTALMENTE
 * independente da tela/Activity do app. Continua rodando mesmo com:
 * - o app minimizado (botão Home);
 * - a tela apagada/bloqueada;
 * - o entregador trocando pra outro app.
 *
 * Só para quando o entregador fica "offline" de propósito (ver
 * LocationTrackingPlugin.stopTracking) - nunca depende da Activity estar
 * viva pra continuar mandando localização.
 *
 * Usa o LocationManager puro do Android (sem depender do Google Play
 * Services/FusedLocationProviderClient, pra não precisar adicionar
 * nenhuma dependência nova ao projeto) - GPS_PROVIDER como fonte
 * principal, NETWORK_PROVIDER como reforço em lugares fechados/sem sinal
 * de GPS direto.
 *
 * A cada posição nova, manda direto pro servidor via HTTP - SEM passar
 * pelo JavaScript/WebView do app (que pode estar suspenso com o app
 * minimizado). É isso que garante o rastreio de verdade em segundo plano.
 */
public class LocationTrackingService extends Service implements LocationListener {

    public static final String ACAO_INICIAR = "com.vtrpdv.motoboy.INICIAR_RASTREIO";
    public static final String ACAO_PARAR = "com.vtrpdv.motoboy.PARAR_RASTREIO";
    public static final String EXTRA_TOKEN = "token";
    public static final String EXTRA_API_BASE = "api_base";

    private static final String CANAL_NOTIFICACAO_ID = "vtr_entregador_rastreio";
    private static final int NOTIFICACAO_ID = 5501;

    // Canal SEPARADO do canal de rastreio acima (que é IMPORTANCE_LOW, sem
    // som, de propósito, pra não incomodar o entregador o tempo todo
    // enquanto está online) - esse aqui é IMPORTANCE_HIGH, com som e
    // vibração, porque uma entrega nova é algo que precisa chamar atenção
    // na hora. A checagem que dispara essa notificação roda AQUI dentro
    // do Service (não no JavaScript/WebView do app) de propósito: é a
    // única forma de continuar avisando o entregador mesmo com o app
    // minimizado, a tela apagada, ou ele estando dentro de outro app
    // (WhatsApp, por exemplo) - o WebView é suspenso pelo Android nesses
    // casos e para de rodar qualquer setInterval, mas esse Service
    // continua vivo (é o mesmo motivo pelo qual o rastreio de GPS foi
    // reescrito pra cá).
    private static final String CANAL_NOVA_ENTREGA_ID = "vtr_entregador_nova_entrega";
    private static final AtomicInteger contadorNotificacaoEntrega = new AtomicInteger(6000);
    // Ids das entregas já conhecidas da última checagem, separados por
    // vírgula - salvo em SharedPreferences (não só em memória) pra
    // sobreviver o Android matar e reiniciar esse Service sozinho: sem
    // isso, um reinício ia esquecer quais entregas já eram conhecidas e
    // notificar de novo TODAS as entregas ativas como se fossem novas.
    private static final String CHAVE_IDS_ENTREGAS_CONHECIDAS = "ids_entregas_conhecidas_service";
    private static final long INTERVALO_CHECAGEM_ENTREGAS_MS = 30000; // 30s

    // Intervalo mínimo entre atualizações mandadas pro servidor - tanto
    // por tempo quanto por distância percorrida, pra não gastar
    // dados/bateria à toa. Mesmo parado (sem andar nada), manda de novo a
    // cada 45s - assim a loja/cliente nunca veem uma posição "velha
    // demais" enquanto o entregador está parado num sinal, por exemplo.
    private static final long INTERVALO_MINIMO_MS = 15000; // pede atualização ao sistema a cada 15s
    private static final float DISTANCIA_MINIMA_METROS = 15f; // só manda pro servidor se andou uns 15m...
    private static final long INTERVALO_MAXIMO_SEM_ENVIAR_MS = 45000; // ...ou 45s tiverem passado, o que vier primeiro

    private LocationManager locationManager;
    private ExecutorService executorEnvio;
    private ScheduledExecutorService executorChecagemEntregas;
    private String tokenMotoboy;
    private String apiBase;
    private Location ultimaPosicaoEnviada;
    private long ultimoEnvioEm = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        executorEnvio = Executors.newSingleThreadExecutor();
        criarCanalNotificacao();
        criarCanalNovaEntregaSeNecessario();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACAO_PARAR.equals(intent.getAction())) {
            pararTudo();
            return START_NOT_STICKY;
        }

        // Lê o token/URL da API do que veio na chamada, ou (se o serviço
        // foi reiniciado sozinho pelo Android depois de ser morto por
        // falta de memória) do que ficou salvo da última vez.
        SharedPreferences prefs = getSharedPreferences("vtr_entregador_prefs", MODE_PRIVATE);
        if (intent != null && intent.hasExtra(EXTRA_TOKEN)) {
            tokenMotoboy = intent.getStringExtra(EXTRA_TOKEN);
            apiBase = intent.getStringExtra(EXTRA_API_BASE);
            prefs.edit().putString("token", tokenMotoboy).putString("api_base", apiBase).apply();
        } else {
            tokenMotoboy = prefs.getString("token", null);
            apiBase = prefs.getString("api_base", "https://vtrpdv.com/api");
        }

        if (tokenMotoboy == null) {
            // Sem token não tem como mandar localização pra lugar nenhum - encerra.
            stopSelf();
            return START_NOT_STICKY;
        }

        iniciarComoForegroundService();
        iniciarAtualizacoesDeLocalizacao();
        iniciarChecagemPeriodicaDeEntregas();

        // START_STICKY: se o Android matar esse serviço por falta de
        // memória (mais comum em aparelhos com pouca RAM), ele tenta
        // subir de novo sozinho assim que possível - o token já fica
        // salvo em SharedPreferences pra esse reinício conseguir
        // continuar rastreando sem precisar que o app esteja aberto.
        return START_STICKY;
    }

    private void criarCanalNotificacao() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel canal = new NotificationChannel(
                CANAL_NOTIFICACAO_ID,
                "Rastreio de entrega",
                NotificationManager.IMPORTANCE_LOW // baixa prioridade: sem som/vibração, só o ícone fixo
            );
            canal.setDescription("Mostrado enquanto você está online recebendo entregas.");
            NotificationManager gerenciador = getSystemService(NotificationManager.class);
            if (gerenciador != null) gerenciador.createNotificationChannel(canal);
        }
    }

    private void iniciarComoForegroundService() {
        Intent intentAbrirApp = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, intentAbrirApp,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0
        );

        Notification notificacao = new NotificationCompat.Builder(this, CANAL_NOTIFICACAO_ID)
            .setContentTitle("Entregador online")
            .setContentText("Sua localização está sendo compartilhada com a loja.")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build();

        if (Build.VERSION.SDK_INT >= 34) { // Android 14+ (UPSIDE_DOWN_CAKE) exige informar o tipo na hora de chamar, não só no manifesto
            startForeground(NOTIFICACAO_ID, notificacao, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICACAO_ID, notificacao);
        }
    }

    private void iniciarAtualizacoesDeLocalizacao() {
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, INTERVALO_MINIMO_MS, 0f, this);
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, INTERVALO_MINIMO_MS, 0f, this);
            }
        } catch (SecurityException e) {
            // Permissão de localização foi revogada no meio do caminho (a
            // pessoa foi em Configurações e desligou manualmente) - para
            // o serviço, não adianta continuar tentando sem permissão.
            pararTudo();
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        if (location == null) return;

        long agora = System.currentTimeMillis();
        boolean andouADistanciaMinima = ultimaPosicaoEnviada == null
            || location.distanceTo(ultimaPosicaoEnviada) >= DISTANCIA_MINIMA_METROS;
        boolean jaPassouOIntervaloMaximo = (agora - ultimoEnvioEm) >= INTERVALO_MAXIMO_SEM_ENVIAR_MS;

        if (!andouADistanciaMinima && !jaPassouOIntervaloMaximo) {
            return; // ainda não andou o suficiente nem passou tempo demais - espera a próxima
        }

        ultimaPosicaoEnviada = location;
        ultimoEnvioEm = agora;
        enviarLocalizacaoParaServidor(location);
    }

    private void enviarLocalizacaoParaServidor(Location location) {
        final String token = tokenMotoboy;
        final String base = apiBase;
        final double latitude = location.getLatitude();
        final double longitude = location.getLongitude();

        executorEnvio.execute(() -> {
            HttpURLConnection conexao = null;
            try {
                URL url = new URL(base + "/atualizar_localizacao_motoboy.php");
                conexao = (HttpURLConnection) url.openConnection();
                conexao.setRequestMethod("POST");
                conexao.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                conexao.setConnectTimeout(15000);
                conexao.setReadTimeout(15000);
                conexao.setDoOutput(true);

                String corpoJson = "{\"token\":\"" + escaparJson(token) + "\","
                    + "\"latitude\":" + latitude + ","
                    + "\"longitude\":" + longitude + "}";

                try (OutputStream saida = conexao.getOutputStream()) {
                    saida.write(corpoJson.getBytes(StandardCharsets.UTF_8));
                }
                conexao.getResponseCode(); // só dispara a chamada de verdade - não precisamos ler a resposta
            } catch (Exception e) {
                // Falha de rede pontual (sem internet no momento, por
                // exemplo) - não é um erro fatal, só não conseguiu mandar
                // ESSA posição específica; a próxima atualização de
                // localização naturalmente tenta de novo.
            } finally {
                if (conexao != null) conexao.disconnect();
            }
        });
    }

    // ---------- Checagem de entregas novas (independente de tela/app) ----------
    // Roda de tempos em tempos DIRETO NESSE SERVICE (não no JS), pra
    // continuar avisando o entregador de uma entrega nova mesmo com o
    // app minimizado, a tela apagada, ou ele estando dentro de outro app
    // (WhatsApp, câmera, etc.) - situações em que o Android suspende o
    // WebView e qualquer setInterval do JavaScript simplesmente para de
    // rodar, então só uma checagem nativa consegue notificar de verdade
    // nesses momentos.
    private void iniciarChecagemPeriodicaDeEntregas() {
        if (executorChecagemEntregas != null && !executorChecagemEntregas.isShutdown()) return; // já rodando
        executorChecagemEntregas = Executors.newSingleThreadScheduledExecutor();
        executorChecagemEntregas.scheduleWithFixedDelay(
            this::checarEntregasNovas, 5, INTERVALO_CHECAGEM_ENTREGAS_MS / 1000, TimeUnit.SECONDS
        );
    }

    private void checarEntregasNovas() {
        if (tokenMotoboy == null) return;
        HttpURLConnection conexao = null;
        try {
            URL url = new URL(apiBase + "/motoboy_minhas_entregas.php?token=" + URLEncoder.encode(tokenMotoboy, "UTF-8"));
            conexao = (HttpURLConnection) url.openConnection();
            conexao.setRequestMethod("GET");
            conexao.setConnectTimeout(10000);
            conexao.setReadTimeout(10000);

            if (conexao.getResponseCode() != 200) return;

            StringBuilder corpo = new StringBuilder();
            try (InputStream entrada = conexao.getInputStream();
                 BufferedReader leitor = new BufferedReader(new InputStreamReader(entrada, StandardCharsets.UTF_8))) {
                String linha;
                while ((linha = leitor.readLine()) != null) corpo.append(linha);
            }

            JSONObject json = new JSONObject(corpo.toString());
            if (!"sucesso".equals(json.optString("status"))) return;
            JSONArray entregasArray = json.optJSONArray("entregas");
            if (entregasArray == null) return;

            SharedPreferences prefs = getSharedPreferences("vtr_entregador_prefs", MODE_PRIVATE);
            String idsConhecidosSalvos = prefs.getString(CHAVE_IDS_ENTREGAS_CONHECIDAS, null);
            // null = primeira checagem desde que esse Service (re)começou
            // a rodar - nesse caso só REGISTRA o que já existe, sem
            // notificar nada; senão, toda entrega que já estava atribuída
            // ANTES do Service (re)iniciar ia disparar uma notificação à
            // toa, como se fosse nova.
            Set<String> idsConhecidos = idsConhecidosSalvos == null ? null : new HashSet<>(java.util.Arrays.asList(idsConhecidosSalvos.split(",")));

            Set<String> idsAtuais = new HashSet<>();
            java.util.List<JSONObject> novas = new java.util.ArrayList<>();
            for (int i = 0; i < entregasArray.length(); i++) {
                JSONObject entrega = entregasArray.getJSONObject(i);
                String id = entrega.optString("id", "");
                if (id.isEmpty()) continue;
                idsAtuais.add(id);
                if (idsConhecidos != null && !idsConhecidos.contains(id)) novas.add(entrega);
            }

            prefs.edit().putString(CHAVE_IDS_ENTREGAS_CONHECIDAS, String.join(",", idsAtuais)).apply();
            if (idsConhecidos == null || novas.isEmpty()) return;

            if (novas.size() == 1) {
                JSONObject e = novas.get(0);
                String cliente = e.optString("cliente_nome", "");
                String endereco = e.optString("endereco_entrega", "");
                String mensagem = (cliente.isEmpty() ? "" : cliente + " - ") + (endereco.isEmpty() ? "toque pra ver os detalhes" : endereco);
                notificarEntregaNova("🛵 Nova entrega pra você!", mensagem);
            } else {
                notificarEntregaNova("🛵 Novas entregas pra você!", novas.size() + " entregas novas foram atribuídas a você");
            }
        } catch (Exception e) {
            // Falha de rede pontual (sem internet no momento, servidor
            // fora do ar etc.) - não é fatal, a próxima checagem (30s
            // depois) tenta de novo sozinha.
        } finally {
            if (conexao != null) conexao.disconnect();
        }
    }

    private void notificarEntregaNova(String titulo, String mensagem) {
        Intent intentAbrirApp = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, intentAbrirApp,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? (PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
                : PendingIntent.FLAG_UPDATE_CURRENT
        );

        Notification notificacao = new NotificationCompat.Builder(this, CANAL_NOVA_ENTREGA_ID)
            .setContentTitle(titulo)
            .setContentText(mensagem)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_SOUND | NotificationCompat.DEFAULT_VIBRATE)
            .build();

        try {
            // ID crescente: cada entrega nova vira uma notificação própria
            // (empilha na barra), em vez de ir substituindo a anterior.
            NotificationManagerCompat.from(this).notify(contadorNotificacaoEntrega.incrementAndGet(), notificacao);
        } catch (SecurityException e) {
            // Android 13+ exige a permissão POST_NOTIFICATIONS - se o
            // entregador negou, só não mostra a notificação (a checagem
            // continua rodando normalmente do mesmo jeito, sem travar
            // nada por causa disso).
        }
    }

    private void criarCanalNovaEntregaSeNecessario() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel canal = new NotificationChannel(
                CANAL_NOVA_ENTREGA_ID,
                "Nova entrega atribuída",
                NotificationManager.IMPORTANCE_HIGH
            );
            canal.setDescription("Avisa com som quando uma entrega nova é atribuída a você, mesmo com o app minimizado ou a tela apagada.");
            canal.enableVibration(true);
            NotificationManager gerenciador = getSystemService(NotificationManager.class);
            if (gerenciador != null) gerenciador.createNotificationChannel(canal);
        }
    }

    private String escaparJson(String texto) {
        return texto == null ? "" : texto.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private void pararTudo() {
        try { locationManager.removeUpdates(this); } catch (Exception e) { /* já parado */ }
        if (executorChecagemEntregas != null) executorChecagemEntregas.shutdownNow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(Service.STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        try { locationManager.removeUpdates(this); } catch (Exception e) { /* já parado */ }
        if (executorEnvio != null) executorEnvio.shutdown();
        if (executorChecagemEntregas != null) executorChecagemEntregas.shutdownNow();
        super.onDestroy();
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) { /* API antiga do LocationListener - nada a fazer aqui */ }
    @Override
    public void onProviderEnabled(String provider) { /* opcional: poderia avisar o app que o GPS foi ligado */ }
    @Override
    public void onProviderDisabled(String provider) { /* opcional: poderia avisar o app que o GPS foi desligado */ }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null; // não usamos bind, só start/stop via Intent
    }
}
