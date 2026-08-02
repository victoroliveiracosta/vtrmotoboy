# VTR Motoboy

App do entregador do VTR PDV. Manda a localização em tempo real pra loja
acompanhar a entrega, mesmo com a tela apagada ou o app em segundo plano.

## Como funciona

- O gerente cria o motoboy no painel (Entregas → Motoboys), copia o link
  de rastreio que já existe hoje - só que em vez de mandar o **link**
  pro motoboy, agora manda o **código** que vem no final desse link
  (a parte depois de `?token=`).
- O motoboy abre o app uma vez, cola esse código, e pronto - fica
  logado permanentemente naquele aparelho.
- O app manda a localização pro mesmo lugar que já era usado antes
  (`atualizar_localizacao_motoboy.php`) - o mapa da loja
  (`admin_loja/mapa_motoboy.php`) continua funcionando sem nenhuma
  mudança.

## Como gerar o APK (sem precisar instalar nada no computador)

1. Suba esse projeto inteiro num repositório do GitHub (pode ser
   privado).
2. Assim que subir, o GitHub já começa a compilar sozinho (o arquivo
   `.github/workflows/build-android.yml` cuida disso).
3. Vai na aba **Actions** do repositório, clica na execução mais
   recente (o nome é "Build APK do VTR Motoboy"), espera terminar
   (leva uns 3-5 minutos).
4. Desce até **Artifacts**, baixa o `vtr-motoboy-apk.zip`, descompacta -
   dentro tem o `app-debug.apk`.
5. Manda esse `.apk` pro celular do motoboy (por WhatsApp, Google Drive,
   o que for mais fácil) e instala. O Android vai avisar "fonte
   desconhecida" - é normal pra apps instalados fora da Play Store,
   só confirmar.

## Se quiser recompilar depois de alguma alteração

Só precisa mandar (`git push`) a alteração pro GitHub de novo - ele
recompila sozinho e gera um novo APK em Artifacts.

## Arquivos importantes

- `www/index.html` e `www/app.js` - o app em si (tela de login, lista
  de entregas, rastreio GPS)
- `capacitor.config.ts` - configurações gerais do app (nome, ícone, etc)
- `android/` - o projeto Android nativo (gerado automaticamente pelo
  Capacitor - normalmente não precisa mexer aqui direto)
- `.github/workflows/build-android.yml` - a receita que o GitHub usa
  pra compilar o APK sozinho

## Sobre a versão "debug" do APK

O APK gerado por esse workflow é uma versão de teste/desenvolvimento -
funciona perfeitamente pra instalar direto nos celulares dos motoboys,
mas não pode ser publicado na Google Play Store como está (pra isso
precisaria de uma "assinatura" própria, um passo a mais que não é
necessário se a ideia é só instalar manualmente, sem passar pela loja
de aplicativos).

## Personalizando o ícone do app

O app está usando o ícone padrão do Capacitor por enquanto. Pra trocar
pela logo do VTR PDV, é só substituir os arquivos dentro de
`android/app/src/main/res/mipmap-*/` (várias resoluções do mesmo
ícone) - ou usar a ferramenta `@capacitor/assets` pra gerar tudo
automático a partir de uma imagem só.
