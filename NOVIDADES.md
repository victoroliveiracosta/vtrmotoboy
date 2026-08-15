# Novidades desta atualização (VTR Entregador)

## Visual novo, seguindo os prints que você mandou

- Nome do app mudou de "VTR Motoboy" pra **"VTR Entregador"** (nome
  exibido no celular - o pacote técnico interno continua
  `com.vtrpdv.motoboy`, de propósito, pra não perder o vínculo com quem
  já tiver o app instalado).
- Ícone e tela de abertura (splash) atualizados com a logo nova que você
  mandou.
- Cabeçalho com o gradiente azul de marca.
- Nova navegação inferior com 4 abas: **Entregas**, **Mapa**, **Ganhos**
  e **Perfil** - igual aos prints.

## Fluxo "Cheguei no local" → "Entregue" / "Não atendido"

Exatamente como no seu print de referência:

1. Entrega "a caminho" mostra o botão **"Cheguei no local"**.
2. Ao tocar, o status muda pra **"Aguardando cliente"** e aparecem 2
   botões: **"Entregue"** (verde) e **"Não atendido"** (laranja).
3. Se marcar "Não atendido": a venda é **cancelada de verdade** no
   sistema (não entra no caixa nem no faturamento), com o motivo
   "Entregador não atendido no endereço." salvo e visível tanto pro
   caixa quanto pro administrador/gerente no relatório do PDV.
4. O cliente recebe uma mensagem automática no WhatsApp em cada uma
   dessas duas ações (chegou no local / não atendido) - se a loja tiver
   o WhatsApp conectado.

**Importante**: a parte de trás (servidor) dessa mudança está numa
entrega separada (entrega80) que precisa ser instalada no site
`vtrpdv.com` - sem ela, os botões novos do app não funcionam.

## Informação de pagamento no card da entrega

Cada entrega agora mostra:
- Se já foi pago (Pix/Cartão Online) ou se precisa cobrar na entrega.
- Se for dinheiro: quanto cobrar e quanto de troco dar.
- Forma de pagamento específica (Cartão de Crédito vs Débito).

## Aba Ganhos

Total do dia, comparação com ontem, gráfico dos últimos 7 dias e ticket
médio - usando os dados reais de cada entregador.

## Aba Mapa

Sem uma chave de mapa (Google Maps/Mapbox) configurada ainda, por
enquanto essa aba mostra a lista de entregas ativas com endereço em
destaque e um botão grande pra abrir a rota completa no Google Maps do
aparelho - em vez de um mapa embutido "de mentirinha" que não
funcionaria de verdade. Se quiser um mapa interativo de verdade dentro
do app (como no mockup, com o desenho da rota), é um passo futuro que
precisa de uma chave paga do Google Maps (ou similar).

## Aba Perfil

Mostra nome, telefone e ID do entregador, e o botão de sair. As seções
de "editar dados pessoais", "veículo" e "documentos" do mockup ainda
não têm campo/cadastro correspondente no sistema hoje - ficam como
próximo passo se você quiser que os entregadores consigam editar esses
dados pelo próprio app.

## Como aplicar

1. Instale a entrega80 no servidor primeiro (arquivos PHP + SQL).
2. Suba esse projeto (a pasta inteira) pro GitHub, do mesmo jeito que já
   fazia antes - o Actions recompila o APK sozinho.
3. Baixe o novo `.apk` em Artifacts e reinstale nos celulares dos
   entregadores (por cima do app antigo funciona, mesmo pacote).
