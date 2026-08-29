package com.vtrpdv.motoboy;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        pedirParaIgnorarOtimizacaoDeBateria();
    }

    // Pede pro Android parar de "otimizar" (ou seja, poder encerrar) esse
    // app quando ele estiver em segundo plano - sem isso, mesmo com o
    // serviço de rastreio em primeiro plano configurado certinho, o
    // Android pode simplesmente matar o processo do app depois de um
    // tempo minimizado pra economizar bateria. Isso é especialmente
    // agressivo em celulares Xiaomi (MIUI), Samsung e Motorola.
    //
    // Mostra a caixinha de sistema "Permitir que VTR Entregador ignore
    // as otimizações de bateria?" - só precisa ser aceita uma vez.
    private void pedirParaIgnorarOtimizacaoDeBateria() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            String pacote = getPackageName();
            if (pm != null && !pm.isIgnoringBatteryOptimizations(pacote)) {
                try {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + pacote));
                    startActivity(intent);
                } catch (Exception e) {
                    // Alguns aparelhos (principalmente Xiaomi/Huawei) bloqueiam
                    // essa tela de sistema por conta própria - se der erro,
                    // ignora; o entregador ainda consegue liberar manualmente
                    // depois em Configurações > Bateria > VTR Entregador >
                    // Sem restrições.
                }
            }
        }
    }
}
