// ---------------------------------------------------------------------
// VTR Entregador - app do entregador do VTR PDV.
// Sem bundler de propósito (mesmo estilo do resto do VTR PDV): os
// plugins nativos do Capacitor ficam disponíveis direto em
// window.Capacitor.Plugins, sem precisar importar/empacotar nada.
// ---------------------------------------------------------------------

const API_BASE = 'https://vtrpdv.com/api';
const CHAVE_TOKEN = 'vtr_motoboy_token';
// Códigos de confirmação de entrega (quando a loja liga essa opção) -
// guardados no aparelho assim que a lista de entregas é baixada, pra
// funcionar mesmo se a internet cair bem na hora de confirmar a entrega
// (ver salvarCodigosConfirmacaoLocal/marcarEntregue). Sobrevive até o app
// ser fechado/reaberto, diferente de uma variável comum em memória.
const CHAVE_CODIGOS_CONFIRMACAO = 'vtr_motoboy_codigos_confirmacao';
// Entregas que o entregador já confirmou (código certo digitado) enquanto
// estava OFFLINE - ficam guardadas aqui até a internet voltar e o app
// conseguir avisar o servidor de verdade. O entregador NUNCA fica travado
// esperando internet só pra continuar trabalhando: assim que confirma
// certo, a entrega já some da lista dele (ver renderizarEntregas), mesmo
// sem servidor nenhum saber disso ainda.
const CHAVE_PENDENTES_OFFLINE = 'vtr_motoboy_pendentes_offline';

let tokenAtual = null;
let watcherIdGps = null;
let intervalAtualizarEntregas = null;
let ultimasEntregasCarregadas = [];
let motoboyIdAtual = null;
let motoboyTelefoneAtual = null;
// Espelho em memória de CHAVE_PENDENTES_OFFLINE, pra renderizarEntregas()
// conseguir filtrar a lista sem precisar virar uma função assíncrona (o
// Preferences do Capacitor é sempre assíncrono) - toda vez que
// carregarPendentesOfflineLocal()/salvarPendentesOfflineLocal() rodam,
// esse espelho é atualizado junto.
let pendentesOfflineEmMemoria = {};
// Qual entrega está com o modal de código aberto no momento (setado por
// marcarEntregue, lido por confirmarCodigoEntregaDigitado).
let vendaIdAguardandoCodigo = null;

function pluginsCapacitor() {
    return (window.Capacitor && window.Capacitor.Plugins) || {};
}

// ---------- Preferences: helpers genéricos pra guardar/ler um objeto
// JSON qualquer no aparelho (usados pelos códigos de confirmação e pela
// fila de entregas pendentes de sincronizar) ----------
async function salvarObjetoLocal(chave, objeto) {
    const texto = JSON.stringify(objeto || {});
    const { Preferences } = pluginsCapacitor();
    if (Preferences) {
        await Preferences.set({ key: chave, value: texto });
    } else {
        localStorage.setItem(chave, texto); // fallback pra testar num navegador comum
    }
}
async function lerObjetoLocal(chave) {
    const { Preferences } = pluginsCapacitor();
    let texto = null;
    if (Preferences) {
        const resultado = await Preferences.get({ key: chave });
        texto = resultado.value;
    } else {
        texto = localStorage.getItem(chave);
    }
    try {
        return texto ? JSON.parse(texto) : {};
    } catch (e) {
        return {};
    }
}

// ---------- Preferences (guarda o token no aparelho) ----------

async function salvarTokenLocal(token) {
    const { Preferences } = pluginsCapacitor();
    if (Preferences) {
        await Preferences.set({ key: CHAVE_TOKEN, value: token });
    } else {
        localStorage.setItem(CHAVE_TOKEN, token); // fallback pra testar num navegador comum
    }
}

async function lerTokenLocal() {
    const { Preferences } = pluginsCapacitor();
    if (Preferences) {
        const resultado = await Preferences.get({ key: CHAVE_TOKEN });
        return resultado.value;
    }
    return localStorage.getItem(CHAVE_TOKEN);
}

async function apagarTokenLocal() {
    const { Preferences } = pluginsCapacitor();
    if (Preferences) {
        await Preferences.remove({ key: CHAVE_TOKEN });
    } else {
        localStorage.removeItem(CHAVE_TOKEN);
    }
}

// ---------- Telas ----------

function mostrarTela(id) {
    ['tela-carregando', 'tela-login', 'tela-principal'].forEach(t => {
        document.getElementById(t).classList.toggle('hidden', t !== id);
    });
}

// ---------- Navegação principal (Entregas / Mapa / Ganhos / Perfil) ----------

let abaPrincipalAtual = 'entregas';

function mudarAbaPrincipal(aba) {
    abaPrincipalAtual = aba;
    ['entregas', 'mapa', 'ganhos', 'perfil'].forEach(a => {
        document.getElementById(`secao-${a}`).classList.toggle('hidden', a !== aba);
        const botao = document.getElementById(`nav-${a}`);
        botao.className = `flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 ${a === aba ? 'text-blue-700' : 'text-slate-400'}`;
    });
    if (aba === 'mapa') renderizarMapa();
    if (aba === 'ganhos') carregarGanhos();
    if (aba === 'perfil') carregarPerfil();
}

// ---------- Login ----------

async function fazerLogin() {
    const token = document.getElementById('input-token-login').value.trim();
    const erroEl = document.getElementById('erro-login');
    erroEl.classList.add('hidden');

    if (!token) {
        erroEl.textContent = 'Cole o código que a loja te enviou.';
        erroEl.classList.remove('hidden');
        return;
    }

    const botao = document.getElementById('botao-entrar');
    botao.disabled = true;
    botao.textContent = 'Entrando...';

    try {
        const resposta = await fetch(`${API_BASE}/motoboy_minhas_entregas.php?token=${encodeURIComponent(token)}`);
        const resultado = await resposta.json();

        if (resultado.status === 'sucesso') {
            await salvarTokenLocal(token);
            await iniciarAppLogado(token, resultado.motoboy_nome);
        } else {
            erroEl.textContent = resultado.mensagem || 'Código inválido.';
            erroEl.classList.remove('hidden');
        }
    } catch (e) {
        erroEl.textContent = 'Erro de conexão. Confira sua internet e tente de novo.';
        erroEl.classList.remove('hidden');
    } finally {
        botao.disabled = false;
        botao.textContent = 'Entrar';
    }
}

function sair() {
    if (!confirm('Sair e parar o rastreamento?')) return;
    ficarOffline();
    if (intervalAtualizarEntregas) clearInterval(intervalAtualizarEntregas);
    apagarTokenLocal();
    tokenAtual = null;
    document.getElementById('input-token-login').value = '';
    mostrarTela('tela-login');
}

// ---------- App logado ----------

async function iniciarAppLogado(token, nomeMotoboy) {
    tokenAtual = token;
    document.getElementById('nome-motoboy-header').textContent = nomeMotoboy || 'Entregador';
    mostrarTela('tela-principal');
    mudarAbaPrincipal('entregas');

    // Pede a permissão de notificação (Android 13+) logo na entrada -
    // antes disso, o app nunca perguntava isso sozinho, e o entregador
    // precisava achar essa opção na mão lá em Configurações. Se o
    // aparelho já concedeu ou já negou antes, o Android nem mostra nada
    // aqui, só devolve o estado atual - só aparece a caixinha de verdade
    // na PRIMEIRA vez.
    pedirPermissaoNotificacao();

    // Carrega a fila de entregas confirmadas offline ANTES da primeira
    // renderização - se o app foi fechado e reaberto ainda sem internet,
    // essas entregas já continuam fora da lista (e a sincronização já
    // roda assim que carregarEntregas() perceber que voltou o sinal).
    await carregarPendentesOfflineLocal();

    // Já entra online automaticamente (comportamento de sempre) - o
    // entregador pode escolher ficar offline manualmente depois, pelo
    // botão no topo da tela (ver alternarOnlineOffline).
    await ficarOnline();
    await carregarEntregas();

    // Atualiza a lista de entregas sozinha de tempos em tempos, pra
    // aparecer uma entrega nova sem precisar fechar e abrir o app. 15s
    // (era 30s) - entrega nova pra atender é uma coisa sensível a tempo,
    // vale a pena atualizar mais rápido.
    if (intervalAtualizarEntregas) clearInterval(intervalAtualizarEntregas);
    intervalAtualizarEntregas = setInterval(() => {
        carregarEntregas();
        if (abaPrincipalAtual === 'mapa') renderizarMapa();
    }, 15000);

    // O problema principal não é o intervalo em si - é que o Android
    // pausa o JavaScript quando o app vai pra segundo plano (o
    // entregador troca de tela, olha o WhatsApp, etc.), então o
    // setInterval acima simplesmente para de rodar. Sem isso, ele só via
    // a entrega nova depois de tocar "Atualizar" na mão. Agora, assim
    // que o app volta pra frente (resume), atualiza na hora - sem
    // esperar o próximo tick do intervalo.
    configurarAtualizacaoAoVoltarParaFrente();
}

let atualizacaoAoVoltarConfigurada = false;
// Status conhecido mais recente do GPS - existe porque, quando o app fica
// muito tempo minimizado, o Android às vezes recarrega a tela do zero
// pra economizar memória (comportamento do sistema, fora do nosso
// controle). Isso fazia o indicador de GPS voltar pra "Conectando..." (ou
// pior, parecer desligado) até chegar uma posição nova - mesmo o GPS
// continuando de verdade ativo em segundo plano o tempo todo. Guardando
// o último status e reaplicando ele assim que o app volta pra frente,
// o indicador nunca mais mostra "desligado" sem motivo.
let ultimoStatusGpsConhecido = 'conectando';
function configurarAtualizacaoAoVoltarParaFrente() {
    if (atualizacaoAoVoltarConfigurada) return;
    atualizacaoAoVoltarConfigurada = true;

    const aoVoltarParaFrente = () => {
        if (!tokenAtual) return;
        carregarEntregas();
        // Reaplica o indicador de GPS na hora (não espera a próxima posição
        // chegar) - ver comentário em ultimoStatusGpsConhecido acima.
        atualizarIndicadorGps(ultimoStatusGpsConhecido);
        // Reforço: tenta sincronizar qualquer ação offline pendente assim
        // que o app volta pra frente - normalmente isso já acontece
        // sozinho em segundo plano (ver o "tique" de GPS dentro de
        // iniciarRastreioGps), mas se o entregador não andou nada
        // enquanto estava com a tela apagada, pode não ter tido nenhum
        // tique de GPS pra disparar isso - aqui é a garantia final.
        if (navigator.onLine) sincronizarPendentesOffline();
    };

    const { App: AppPlugin } = pluginsCapacitor();
    if (AppPlugin && AppPlugin.addListener) {
        AppPlugin.addListener('resume', aoVoltarParaFrente);
    }
    // Fallback pra quando testado num navegador comum (sem o plugin
    // nativo) - mesma ideia, via evento padrão da aba/página.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') aoVoltarParaFrente();
    });
}

// ---------- Formatação de pagamento (troco, crédito/débito, pago/a receber) ----------

const NOMES_FORMA_PAGAMENTO = {
    pix: 'Pix',
    cartao: 'Cartão',
    cartao_credito: 'Cartão de Crédito',
    cartao_debito: 'Cartão de Débito',
    cartao_online: 'Cartão Online',
    vale_refeicao: 'Vale-Refeição',
    dinheiro: 'Dinheiro',
    fiado: 'Fiado',
};

// Monta o texto+cor da forma de pagamento de uma entrega, incluindo:
// - se já foi pago (pix/cartão online) ou se o entregador precisa
//   cobrar na entrega
// - troco, quando for dinheiro e o cliente pediu troco de verdade
function montarInfoPagamento(entrega) {
    if (!entrega.forma_pagamento) {
        return '<span class="text-xs text-slate-400">Pagamento não informado</span>';
    }
    const nomeForma = NOMES_FORMA_PAGAMENTO[entrega.forma_pagamento] || entrega.forma_pagamento;

    if (entrega.ja_pago) {
        return `<span class="inline-flex items-center gap-1 text-xs font-semibold text-green-700 bg-green-50 border border-green-100 rounded-lg px-2 py-1">✅ ${escapeHtml(nomeForma)} · já pago</span>`;
    }

    if (entrega.forma_pagamento === 'dinheiro') {
        const valorPago = parseFloat(entrega.valor_pago || 0);
        const total = parseFloat(entrega.valor_total || 0);
        const troco = parseFloat(entrega.troco || 0);
        const trocoInfo = (valorPago > 0 && troco > 0)
            ? ` · troco para R$ ${fmtMoeda(valorPago)} (dar R$ ${fmtMoeda(troco)} de troco)`
            : (valorPago > 0 ? ' · sem troco' : '');
        return `<span class="inline-flex items-start gap-1 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1">💵 ${escapeHtml(nomeForma)} · cobrar R$ ${fmtMoeda(total)}${trocoInfo}</span>`;
    }

    // Cartão (crédito/débito específico se soubermos) e vale-refeição -
    // pagos na hora da entrega, o entregador só precisa saber a forma.
    return `<span class="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1">💳 ${escapeHtml(nomeForma)} · cobrar na entrega</span>`;
}

function fmtMoeda(v) {
    return parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

// ---------- Entregas ----------

let abaEntregasMotoboyAtual = 'ativas';

function mudarAbaEntregasMotoboy(aba) {
    abaEntregasMotoboyAtual = aba;
    const ativo = 'flex-1 py-2 rounded-lg text-sm font-semibold bg-blue-700 text-white';
    const inativo = 'flex-1 py-2 rounded-lg text-sm font-semibold bg-white border border-slate-200 text-slate-600';
    document.getElementById('aba-motoboy-ativas').className = aba === 'ativas' ? ativo : inativo;
    document.getElementById('aba-motoboy-historico').className = aba === 'historico' ? ativo : inativo;
    carregarEntregas();
}

async function carregarEntregas() {
    if (!tokenAtual) return;
    const lista = document.getElementById('lista-entregas');

    // Antes de mais nada, se a internet estiver de volta, tenta mandar
    // pro servidor qualquer entrega que foi confirmada offline (código
    // certo digitado sem sinal) e ainda está esperando pra sincronizar.
    if (navigator.onLine) sincronizarPendentesOffline();

    try {
        const historico = abaEntregasMotoboyAtual === 'historico' ? '&historico=1' : '';
        const resposta = await fetch(`${API_BASE}/motoboy_minhas_entregas.php?token=${encodeURIComponent(tokenAtual)}${historico}`);
        const resultado = await resposta.json();

        if (resultado.status !== 'sucesso') {
            lista.innerHTML = `<p class="text-center text-slate-400 py-10 text-sm">${escapeHtml(resultado.mensagem || 'Erro ao carregar entregas.')}</p>`;
            return;
        }

        ultimasEntregasCarregadas = resultado.entregas || [];
        if (resultado.motoboy_id) motoboyIdAtual = resultado.motoboy_id;
        if (resultado.motoboy_telefone) motoboyTelefoneAtual = resultado.motoboy_telefone;
        // Reaplica localmente qualquer "cheguei no local" que ainda está
        // esperando a internet voltar pra sincronizar de verdade - sem
        // isso, essa atualização da lista (que reflete o que o SERVIDOR
        // ainda pensa, sem saber do "cheguei" ainda) ia sobrescrever o
        // estado que já tínhamos mostrado na tela, fazendo o card voltar
        // pra "A caminho" do nada.
        reaplicarPendentesLocalmente();
        // Guarda os códigos de confirmação de cada entrega no aparelho -
        // é isso que permite confirmar a entrega mesmo sem internet depois
        // (ver marcarEntregue). Só entregas ativas têm código pra guardar
        // (histórico não precisa mais).
        if (abaEntregasMotoboyAtual !== 'historico') salvarCodigosConfirmacaoLocal(ultimasEntregasCarregadas);
        renderizarEntregas(ultimasEntregasCarregadas);
        if (abaPrincipalAtual === 'mapa') renderizarMapa();
        if (abaPrincipalAtual === 'perfil') carregarPerfil();
    } catch (e) {
        // Falha de rede isolada não precisa incomodar - só mantém a lista antiga na tela.
    }
}

// A notificação de "entrega nova" NÃO é disparada por aqui (não dá pra
// confiar num setInterval do JavaScript pra isso - o Android suspende o
// WebView e para esse tipo de temporizador assim que o app é minimizado,
// a tela apaga, ou o entregador entra em outro app tipo WhatsApp, que é
// bem o cenário que a gente mais precisa notificar). Quem faz essa
// checagem e mostra a notificação é o LocationTrackingService nativo
// (ver checarEntregasNovas lá), que continua rodando o tempo todo
// independente do estado do app - mesmo motivo pelo qual o rastreio de
// GPS também foi movido pra lá.

// Guarda, no aparelho, o código de confirmação de cada entrega ativa -
// assim, se a internet cair bem na hora de confirmar com o cliente, o
// código já está aí, sem depender de nenhuma chamada de rede pra
// conferir se está certo.
async function salvarCodigosConfirmacaoLocal(entregas) {
    const mapa = {};
    (entregas || []).forEach(e => {
        if (e.codigo_confirmacao_entrega) mapa[e.id] = String(e.codigo_confirmacao_entrega);
    });
    await salvarObjetoLocal(CHAVE_CODIGOS_CONFIRMACAO, mapa);
}

// Carrega a fila de entregas confirmadas offline (código certo digitado
// sem internet, ainda esperando pra avisar o servidor) - chamado uma vez
// no início do app, pra já filtrar elas da lista antes mesmo da primeira
// sincronização rodar.
async function carregarPendentesOfflineLocal() {
    pendentesOfflineEmMemoria = await lerObjetoLocal(CHAVE_PENDENTES_OFFLINE);
}

function montarResumoItens(itens) {
    if (!itens || itens.length === 0) return '';
    return itens.map(i => {
        // Se tiver adicionais/opcionais (bebida, sabor, etc), mostra junto
        // do nome do produto - assim o entregador vê "Combo X-tudo (Guaraná,
        // Batata)" em vez de só "Combo X-tudo" e não saber o que levar.
        const adicionaisTexto = (i.opcoes && i.opcoes.length > 0)
            ? ` (${i.opcoes.map(o => escapeHtml(o.item_nome)).join(', ')})`
            : '';
        return `${parseFloat(i.quantidade)}x ${escapeHtml(i.nome)}${adicionaisTexto}`;
    }).join(', ');
}

function renderizarEntregas(entregas) {
    const lista = document.getElementById('lista-entregas');

    // Tira da lista quem já foi confirmado offline (código certo já
    // digitado, só esperando a internet voltar pra avisar o servidor) -
    // pro entregador, aquela entrega já está resolvida, não faz sentido
    // continuar aparecendo como pendente pra ele.
    if (abaEntregasMotoboyAtual !== 'historico') {
        // Só tira da lista quem tem uma ação PENDENTE FINAL (entregue/não
        // atendido) - "chegou" continua aparecendo normalmente, só que já
        // com o estado atualizado (ver atualizarEstadoLocalAposAcao),
        // porque depois de "chegou" ainda falta confirmar entregue/não
        // atendido, então não faz sentido sumir da lista ainda.
        entregas = entregas.filter(e => {
            const pendente = pendentesOfflineEmMemoria[e.id];
            return !pendente || pendente.tipo === 'chegou';
        });
    }

    const qtdPendentesSincronizar = Object.keys(pendentesOfflineEmMemoria).length;
    const avisoPendentes = qtdPendentesSincronizar > 0
        ? `<div class="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-xl p-3 mb-3 flex items-center gap-2">
             <span class="text-lg">🔄</span>
             <span>${qtdPendentesSincronizar} entrega${qtdPendentesSincronizar > 1 ? 's' : ''} confirmada${qtdPendentesSincronizar > 1 ? 's' : ''} sem internet - já ${qtdPendentesSincronizar > 1 ? 'estão' : 'está'} resolvida${qtdPendentesSincronizar > 1 ? 's' : ''}, só falta avisar a loja assim que a internet voltar.</span>
           </div>`
        : '';

    if (entregas.length === 0) {
        lista.innerHTML = avisoPendentes + (abaEntregasMotoboyAtual === 'historico'
            ? '<p class="text-center text-slate-400 py-10 text-sm">Nenhuma entrega no histórico ainda.</p>'
            : '<p class="text-center text-slate-400 py-10 text-sm">Nenhuma entrega no momento. 🎉</p>');
        return;
    }

    if (abaEntregasMotoboyAtual === 'historico') {
        lista.innerHTML = entregas.map(e => {
            const naoAtendido = !!e.nao_atendido;
            const tagStatus = naoAtendido
                ? '<span class="bg-orange-50 text-orange-700 px-2 py-0.5 rounded-full text-xs font-bold flex-shrink-0">🚫 Não atendido</span>'
                : '<span class="bg-green-50 text-green-700 px-2 py-0.5 rounded-full text-xs font-bold flex-shrink-0">✓ Entregue</span>';
            return `
            <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                <div class="flex items-start justify-between gap-2">
                    <p class="font-bold text-slate-800">${escapeHtml(e.cliente_nome || 'Cliente')}${e.numero_pedido ? ` <span class="text-xs text-slate-400 font-normal">#${escapeHtml(e.numero_pedido)}</span>` : ''}</p>
                    ${tagStatus}
                </div>
                <p class="text-xs text-slate-400 mb-1">${e.data_venda ? new Date(e.data_venda.replace(' ', 'T')).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}${e.cliente_telefone ? ` · <a href="tel:${e.cliente_telefone.replace(/\D/g, '')}" class="text-blue-600 font-semibold" onclick="event.stopPropagation()">📞 ${escapeHtml(e.cliente_telefone)}</a>${linkWhatsappCliente(e.cliente_telefone)}` : ''}</p>
                <p class="text-sm text-slate-600 mb-1">📍 ${escapeHtml(e.endereco_entrega || 'Endereço não informado')}</p>
                <p class="text-xs text-slate-500 mb-2">${montarResumoItens(e.itens)}</p>
                ${naoAtendido && e.motivo_cancelamento ? `<p class="text-xs text-orange-700 bg-orange-50 border border-orange-100 rounded-lg px-2 py-1.5 mb-2">${escapeHtml(e.motivo_cancelamento)}</p>` : ''}
                <div class="flex items-center justify-between gap-2">
                    <span class="text-xs text-slate-400">Valor do pedido: R$ ${fmtMoeda(e.valor_total)}</span>
                    ${e.ganho_entrega != null ? `<span class="font-bold text-green-700">💰 R$ ${fmtMoeda(e.ganho_entrega)}</span>` : ''}
                </div>
            </div>`;
        }).join('');
        return;
    }

    lista.innerHTML = avisoPendentes + entregas.map(e => {
        const chegouLocal = e.status_entrega === 'chegou_local';
        const tagTopo = chegouLocal
            ? '<span class="bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full text-xs font-bold flex-shrink-0">⏳ Aguardando cliente</span>'
            : '<span class="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full text-xs font-bold flex-shrink-0">🛵 A caminho</span>';

        let acoesHtml;
        if (chegouLocal) {
            acoesHtml = `
                <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(e.endereco_entrega || '')}" target="_blank" class="bg-slate-100 text-slate-600 px-3 py-2.5 rounded-lg text-xs font-bold text-center">🗺️ Rota</a>
                <button onclick="marcarEntregue('${e.id}')" class="bg-green-600 hover:bg-green-700 text-white px-3 py-2.5 rounded-lg text-xs font-bold">✓ Entregue</button>
                <button onclick="marcarNaoAtendido('${e.id}')" class="border border-orange-300 text-orange-700 hover:bg-orange-50 px-3 py-2.5 rounded-lg text-xs font-bold">🚫 Não atendido</button>
            `;
        } else {
            acoesHtml = `
                <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(e.endereco_entrega || '')}" target="_blank" class="bg-slate-100 text-slate-600 px-3 py-2.5 rounded-lg text-xs font-bold text-center">🗺️ Rota</a>
                <button onclick="marcarChegueiNoLocal('${e.id}')" class="bg-blue-700 hover:bg-blue-800 text-white px-3 py-2.5 rounded-lg text-xs font-bold col-span-2">📍 Cheguei no local</button>
            `;
        }

        return `
        <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <div class="flex items-start justify-between gap-2 mb-1.5">
                <p class="font-bold text-slate-800">${escapeHtml(e.cliente_nome || 'Cliente')}${e.numero_pedido ? ` <span class="text-xs text-slate-400 font-normal">#${escapeHtml(e.numero_pedido)}</span>` : ''}</p>
                ${tagTopo}
            </div>
            <p class="text-xs text-slate-400 mb-1">${e.cliente_telefone ? `<a href="tel:${e.cliente_telefone.replace(/\D/g, '')}" class="text-blue-600 font-semibold" onclick="event.stopPropagation()">📞 ${escapeHtml(e.cliente_telefone)}</a>${linkWhatsappCliente(e.cliente_telefone)}` : ''}</p>
            <p class="text-sm text-slate-600 mb-1">📍 ${escapeHtml(e.endereco_entrega || 'Endereço não informado')}</p>
            <p class="text-xs text-slate-500 mb-2">🛍️ ${montarResumoItens(e.itens) || 'Itens não informados'}</p>
            <div class="mb-3">${montarInfoPagamento(e)}</div>
            ${chegouLocal ? '<p class="text-[11px] text-slate-400 mb-2">Se ninguém atender, registre como "Não atendido" - o horário e sua localização ficam salvos.</p>' : ''}
            <div class="flex items-center justify-between gap-2 mb-3">
                <span class="text-xs text-slate-400">Valor do pedido: R$ ${fmtMoeda(e.valor_total)}</span>
                ${e.ganho_entrega != null ? `<span class="font-bold text-green-700">💰 R$ ${fmtMoeda(e.ganho_entrega)}</span>` : ''}
            </div>
            <div class="grid grid-cols-2 gap-2">${acoesHtml}</div>
        </div>`;
    }).join('');
}

async function marcarChegueiNoLocal(vendaId) {
    await enviarAcaoMotoboy(vendaId, 'chegou', {});
}

// Busca o código de confirmação de uma entrega específica, primeiro na
// lista que já está em memória (mais rápido, cobre o caso comum) e, se
// não achar (app foi reaberto no meio da rota, por exemplo), no que foi
// salvo no aparelho da última vez que a lista foi baixada com internet.
async function buscarCodigoConfirmacaoLocal(vendaId) {
    const daMemoria = (ultimasEntregasCarregadas || []).find(e => e.id === vendaId);
    if (daMemoria && daMemoria.codigo_confirmacao_entrega) return String(daMemoria.codigo_confirmacao_entrega);
    const mapaSalvo = await lerObjetoLocal(CHAVE_CODIGOS_CONFIRMACAO);
    return mapaSalvo[vendaId] || null;
}

// Mostra o modal de "Entrega confirmada!" com o símbolo de OK animado -
// some sozinho depois de um tempinho (não precisa o entregador tocar em
// nada). Antes disso, depois de digitar o código certo (ou confirmar sem
// código), o app só voltava direto pra lista, sem nenhum retorno visual
// de que tinha dado tudo certo.
function mostrarSucessoEntregaConcluida(offline) {
    const modal = document.getElementById('modal-entrega-concluida');
    if (!modal) return;
    const sub = document.getElementById('texto-entrega-concluida-sub');
    if (sub) sub.textContent = offline
        ? 'Sem internet agora - vai avisar a loja assim que a conexão voltar.'
        : 'A loja já foi avisada.';
    modal.classList.remove('hidden');
    clearTimeout(mostrarSucessoEntregaConcluida._timer);
    mostrarSucessoEntregaConcluida._timer = setTimeout(() => modal.classList.add('hidden'), 2200);
}

async function marcarEntregue(vendaId) {
    const codigoExigido = await buscarCodigoConfirmacaoLocal(vendaId);

    // Essa entrega não tem código de confirmação (loja não usa essa
    // opção, ou o motoboy não tem app segundo a loja - mas nesse caso ele
    // nem estaria vendo essa tela) - confirma direto, do jeito de sempre.
    if (!codigoExigido) {
        if (!confirm('Confirmar que essa entrega foi feita?')) return;
        await enviarAcaoMotoboy(vendaId, 'entregue', { codigo_confirmacao: null });
        return;
    }

    // Precisa do código - abre o modal em vez do confirm() simples.
    vendaIdAguardandoCodigo = vendaId;
    document.getElementById('input-codigo-confirmacao').value = '';
    document.getElementById('erro-codigo-confirmacao').classList.add('hidden');
    document.getElementById('modal-codigo-confirmacao').classList.remove('hidden');
    setTimeout(() => document.getElementById('input-codigo-confirmacao')?.focus(), 150);
}

function fecharModalCodigoConfirmacao() {
    document.getElementById('modal-codigo-confirmacao').classList.add('hidden');
    vendaIdAguardandoCodigo = null;
}

// Confere o código digitado CONTRA O QUE JÁ ESTÁ SALVO NO APARELHO - essa
// conferência não depende de internet nenhuma. Se bater, confirma a
// entrega (online de verdade, ou guardada numa fila local se não tiver
// sinal agora); se não bater, mostra erro na hora, mesmo sem internet.
async function confirmarCodigoEntregaDigitado() {
    const vendaId = vendaIdAguardandoCodigo;
    if (!vendaId) return;
    const codigoDigitado = (document.getElementById('input-codigo-confirmacao').value || '').trim();
    const erroEl = document.getElementById('erro-codigo-confirmacao');

    if (codigoDigitado.length < 4) {
        erroEl.textContent = 'Digite o código de 4 números.';
        erroEl.classList.remove('hidden');
        return;
    }

    const codigoCorreto = await buscarCodigoConfirmacaoLocal(vendaId);
    if (codigoDigitado !== codigoCorreto) {
        erroEl.textContent = 'Código incorreto. Confira com o cliente e tente de novo.';
        erroEl.classList.remove('hidden');
        return;
    }

    document.getElementById('modal-codigo-confirmacao').classList.add('hidden');
    vendaIdAguardandoCodigo = null;
    await enviarAcaoMotoboy(vendaId, 'entregue', { codigo_confirmacao: codigoDigitado });
}

// Qual endpoint/corpo da chamada usar pra cada tipo de ação do motoboy -
// usado tanto pra tentativa online quanto pra sincronização depois.
function montarChamadaAcaoMotoboy(vendaId, tipo, dadosExtras) {
    if (tipo === 'chegou') {
        return { url: `${API_BASE}/motoboy_marcar_chegou.php`, body: { token: tokenAtual, venda_id: vendaId } };
    }
    if (tipo === 'nao_atendido') {
        return { url: `${API_BASE}/motoboy_marcar_nao_atendido.php`, body: { token: tokenAtual, venda_id: vendaId } };
    }
    // 'entregue'
    return { url: `${API_BASE}/motoboy_marcar_entregue.php`, body: { token: tokenAtual, venda_id: vendaId, codigo_confirmacao: dadosExtras.codigo_confirmacao || null } };
}

// Ponto único pras 3 ações do motoboy que precisam avisar o servidor
// (chegou no local, entregue, não atendido) - tenta online primeiro; se
// não tiver internet (ou a chamada falhar por qualquer motivo de rede),
// guarda numa fila local em vez de travar o entregador: o app já reflete
// a mudança NA HORA (ver atualizarEstadoLocalAposAcao), e a sincronização
// de verdade com o servidor acontece sozinha assim que a internet voltar
// (ver sincronizarPendentesOffline). O entregador NUNCA fica impedido de
// continuar trabalhando só porque o sinal caiu.
async function enviarAcaoMotoboy(vendaId, tipo, dadosExtras) {
    const { url, body } = montarChamadaAcaoMotoboy(vendaId, tipo, dadosExtras);
    if (navigator.onLine) {
        try {
            const resposta = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const resultado = await resposta.json();
            if (resultado.status === 'sucesso') {
                if (tipo === 'entregue') mostrarSucessoEntregaConcluida(false);
                carregarEntregas();
                return;
            }
            // Erro de verdade do servidor (não é problema de conexão) -
            // avisa e NÃO guarda na fila offline, senão ia ficar tentando
            // sincronizar um erro que nunca vai se resolver sozinho.
            alert(resultado.mensagem || 'Não foi possível registrar. Tente de novo.');
            return;
        } catch (e) {
            // Caiu no meio da chamada (tinha sinal, mas oscilou) - trata
            // como offline mesmo, guarda na fila em vez de travar o entregador.
        }
    }
    if (tipo === 'entregue') mostrarSucessoEntregaConcluida(true);
    await guardarPendenteOffline(vendaId, tipo, dadosExtras);
    atualizarEstadoLocalAposAcao(vendaId, tipo);
    renderizarEntregas(ultimasEntregasCarregadas);
}

// Reflete a ação na tela IMEDIATAMENTE, mesmo sem confirmação nenhuma do
// servidor (ele só vai saber quando a internet voltar) - "chegou" muda o
// cartão pra mostrar os botões de Entregue/Não atendido; "entregue" e
// "não atendido" são estados finais, então saem da lista de ativas (ver
// filtro em renderizarEntregas).
function atualizarEstadoLocalAposAcao(vendaId, tipo) {
    if (tipo === 'chegou') {
        const entrega = (ultimasEntregasCarregadas || []).find(e => e.id === vendaId);
        if (entrega) entrega.status_entrega = 'chegou_local';
    }
}

// Reaplica em ultimasEntregasCarregadas qualquer "cheguei no local" que
// ainda está na fila offline (servidor ainda não sabe) - chamado toda vez
// que a lista é recarregada do servidor, pra essa mudança local não se
// perder até a sincronização de verdade acontecer.
function reaplicarPendentesLocalmente() {
    Object.entries(pendentesOfflineEmMemoria).forEach(([vendaId, item]) => {
        if (item.tipo === 'chegou') atualizarEstadoLocalAposAcao(vendaId, 'chegou');
    });
}

async function guardarPendenteOffline(vendaId, tipo, dadosExtras) {
    pendentesOfflineEmMemoria[vendaId] = { tipo, ...dadosExtras, salvo_em: Date.now() };
    await salvarObjetoLocal(CHAVE_PENDENTES_OFFLINE, pendentesOfflineEmMemoria);
}

// Tenta mandar pro servidor toda ação que foi feita offline e ainda está
// esperando - chamado sempre que a internet volta (evento 'online') e no
// início de carregarEntregas() sempre que já está online. O entregador
// nunca precisa fazer nada manualmente pra isso acontecer.
let sincronizandoPendentesOffline = false;
async function sincronizarPendentesOffline() {
    if (sincronizandoPendentesOffline) return; // evita duas sincronizações ao mesmo tempo
    const idsPendentes = Object.keys(pendentesOfflineEmMemoria);
    if (idsPendentes.length === 0 || !tokenAtual) return;

    sincronizandoPendentesOffline = true;
    for (const vendaId of idsPendentes) {
        const item = pendentesOfflineEmMemoria[vendaId];
        const { url, body } = montarChamadaAcaoMotoboy(vendaId, item.tipo, item);
        try {
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            // Sucesso OU erro "não encontrada" (ex: outro entregador/a loja
            // já mexeu nela nesse meio-tempo) - dos dois jeitos, tira da
            // fila, senão ficava tentando pra sempre uma coisa que nunca
            // vai dar certo. Só mantém na fila em caso de falha de REDE
            // (o catch abaixo, quando o fetch nem consegue completar).
            delete pendentesOfflineEmMemoria[vendaId];
        } catch (e) {
            // Ainda sem internet de verdade (ou instável) - mantém na fila, tenta de novo na próxima.
        }
    }
    await salvarObjetoLocal(CHAVE_PENDENTES_OFFLINE, pendentesOfflineEmMemoria);
    sincronizandoPendentesOffline = false;
    carregarEntregas(); // busca a lista de verdade do servidor de novo, já refletindo o que acabou de sincronizar
}

// Assim que a internet volta (o navegador/Android avisa sozinho), tenta
// sincronizar na hora, sem esperar a próxima atualização automática da
// lista (que pode demorar alguns segundos).
window.addEventListener('online', () => { sincronizarPendentesOffline(); });

async function marcarNaoAtendido(vendaId) {
    if (!confirm('Confirma que ninguém atendeu nesse endereço? O pedido vai ser cancelado - o horário e sua localização atual ficam registrados.')) return;
    await enviarAcaoMotoboy(vendaId, 'nao_atendido', {});
}

// ---------- Aba Mapa ----------
// Não temos uma chave de mapa (Google Maps/Mapbox) configurada ainda,
// então em vez de um mapa embutido "de mentirinha", cada entrega ativa
// mostra o endereço em destaque com um botão grande pra abrir a rota
// completa no Google Maps do aparelho (o mesmo link que já funciona no
// card da aba Entregas).

function renderizarMapa() {
    const lista = document.getElementById('lista-mapa');
    if (!lista) return;
    const ativas = ultimasEntregasCarregadas.filter(e => e.status_entrega === 'saiu_entrega' || e.status_entrega === 'chegou_local');

    if (abaEntregasMotoboyAtual !== undefined && ativas.length === 0) {
        lista.innerHTML = '<p class="text-center text-slate-400 py-10 text-sm">Nenhuma entrega ativa no momento.</p>';
        return;
    }

    lista.innerHTML = ativas.map(e => `
        <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <p class="font-bold text-slate-800 mb-1">${escapeHtml(e.cliente_nome || 'Cliente')}</p>
            ${e.cliente_telefone ? `<a href="tel:${e.cliente_telefone.replace(/\D/g, '')}" class="inline-block text-sm text-blue-600 font-semibold mb-1">📞 ${escapeHtml(e.cliente_telefone)}</a>${linkWhatsappCliente(e.cliente_telefone)}` : ''}
            <p class="text-sm text-slate-600 mb-3">📍 ${escapeHtml(e.endereco_entrega || 'Endereço não informado')}</p>
            <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(e.endereco_entrega || '')}" target="_blank" class="block w-full text-center bg-blue-700 hover:bg-blue-800 text-white font-bold py-2.5 rounded-lg text-sm">🗺️ Abrir rota no Google Maps</a>
        </div>
    `).join('');
}

// ---------- Aba Ganhos ----------

async function carregarGanhos() {
    const bloco = document.getElementById('bloco-ganhos-conteudo');
    if (!tokenAtual || !bloco) return;
    bloco.innerHTML = '<p class="text-center text-slate-400 py-10 text-sm">Carregando...</p>';

    try {
        const resposta = await fetch(`${API_BASE}/motoboy_meus_ganhos.php?token=${encodeURIComponent(tokenAtual)}`);
        const resultado = await resposta.json();
        if (resultado.status !== 'sucesso') {
            bloco.innerHTML = `<p class="text-center text-slate-400 py-10 text-sm">${escapeHtml(resultado.mensagem || 'Erro ao carregar ganhos.')}</p>`;
            return;
        }
        renderizarGanhos(resultado);
    } catch (e) {
        bloco.innerHTML = '<p class="text-center text-slate-400 py-10 text-sm">Erro de conexão.</p>';
    }
}

function renderizarGanhos(dados) {
    const bloco = document.getElementById('bloco-ganhos-conteudo');
    const serie = dados.serie_7_dias || [];
    const maiorValor = Math.max(1, ...serie.map(d => d.ganho));
    const nomesDiaSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

    const variacaoHtml = dados.variacao_percentual_ontem !== null && dados.variacao_percentual_ontem !== undefined
        ? `<span class="inline-flex items-center gap-1 text-xs font-bold ${dados.variacao_percentual_ontem >= 0 ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'} rounded-full px-2.5 py-1">${dados.variacao_percentual_ontem >= 0 ? '↗' : '↘'} ${dados.variacao_percentual_ontem}% em relação a ontem</span>`
        : '';

    const barrasHtml = serie.map(d => {
        const dataObj = new Date(d.dia + 'T00:00:00');
        const alturaPercentual = Math.max(4, Math.round((d.ganho / maiorValor) * 100));
        const hoje = d.dia === new Date().toISOString().slice(0, 10);
        return `
        <div class="flex-1 flex flex-col items-center gap-1">
            <span class="text-[10px] font-bold text-slate-500">${d.ganho > 0 ? 'R$ ' + fmtMoeda(d.ganho) : ''}</span>
            <div class="w-full flex items-end" style="height: 90px;">
                <div class="barra-ganho w-full rounded-t-md ${hoje ? 'bg-blue-700' : 'bg-blue-100'}" style="height: ${alturaPercentual}%;"></div>
            </div>
            <span class="text-[10px] text-slate-400">${nomesDiaSemana[dataObj.getDay()]}</span>
        </div>`;
    }).join('');

    bloco.innerHTML = `
        <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-4">
            <p class="text-sm text-slate-500 mb-1">Total do dia</p>
            <div class="flex items-center justify-between flex-wrap gap-2">
                <p class="text-3xl font-extrabold text-slate-800">R$ ${fmtMoeda(dados.total_hoje)}</p>
                ${variacaoHtml}
            </div>
            <p class="text-xs text-slate-400 mt-1">${dados.qtd_entregas_hoje} entrega(s) concluída(s)</p>
        </div>

        <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-4">
            <p class="font-bold text-slate-700 mb-3">Ganhos dos últimos 7 dias</p>
            <div class="flex items-end gap-2">${barrasHtml}</div>
        </div>

        <div class="bg-white rounded-xl shadow-sm border border-slate-200 divide-y divide-slate-100 mb-4">
            <div class="p-4 flex items-center justify-between">
                <span class="text-sm text-slate-600">Ticket médio por entrega</span>
                <span class="font-bold text-slate-800">R$ ${fmtMoeda(dados.ticket_medio)}</span>
            </div>
        </div>

        <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <p class="font-bold text-slate-700 mb-1">Resumo de período</p>
            <p class="text-xs text-slate-400 mb-3">Veja seu total dos últimos 30 dias, ou escolha um dia específico pra conferir.</p>
            <div id="bloco-ganhos-30dias" class="bg-slate-50 rounded-lg p-3 mb-3">
                <p class="text-xs text-slate-400">Carregando...</p>
            </div>
            <label class="text-xs text-slate-500 font-medium">Ver um dia específico:</label>
            <div class="flex items-center gap-2 mt-1.5">
                <input type="date" id="ganhos-data-especifica-input" class="flex-1 border border-slate-200 rounded-lg px-2.5 py-2 text-sm">
                <button onclick="consultarGanhosDataEspecifica()" class="bg-blue-700 hover:bg-blue-800 text-white px-4 py-2 rounded-lg text-sm font-bold">Ver</button>
            </div>
            <div id="ganhos-data-especifica-resultado" class="mt-3"></div>
        </div>
    `;

    carregarGanhosDetalhe();
}

// Busca o resumo de "últimos 30 dias" separado (endpoint próprio, mesmo
// cálculo do painel da loja) - roda depois do renderizarGanhos() acima
// pra não atrasar a tela principal esperando essa consulta extra.
async function carregarGanhosDetalhe(data) {
    if (!tokenAtual) return;
    try {
        const qsData = data ? `&data=${encodeURIComponent(data)}` : '';
        const resposta = await fetch(`${API_BASE}/motoboy_detalhe_ganhos.php?token=${encodeURIComponent(tokenAtual)}${qsData}`);
        const resultado = await resposta.json();
        if (resultado.status !== 'sucesso') return;

        const bloco30 = document.getElementById('bloco-ganhos-30dias');
        if (bloco30) {
            bloco30.innerHTML = `
                <p class="text-xs text-slate-500">Últimos 30 dias</p>
                <p class="text-lg font-bold text-slate-800">${resultado.ultimos_30_dias.qtd_entregas} entrega(s) · <span class="text-green-700">R$ ${fmtMoeda(resultado.ultimos_30_dias.ganho)}</span></p>
            `;
        }

        const elResultadoData = document.getElementById('ganhos-data-especifica-resultado');
        if (elResultadoData) {
            if (resultado.data_especifica) {
                const d = resultado.data_especifica;
                const dataBr = new Date(d.data + 'T00:00:00').toLocaleDateString('pt-BR');
                elResultadoData.innerHTML = `<div class="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5">
                    <p class="text-xs text-blue-700 font-medium">${dataBr}</p>
                    <p class="text-sm font-bold text-slate-800">${d.qtd_entregas} entrega(s) · <span class="text-green-700">R$ ${fmtMoeda(d.ganho)}</span></p>
                    ${d.qtd_nao_atendida > 0 ? `<p class="text-xs text-orange-600 mt-0.5">🚫 ${d.qtd_nao_atendida} não atendida(s) nesse dia</p>` : ''}
                </div>`;
            } else {
                elResultadoData.innerHTML = '';
            }
        }
    } catch (e) {
        // Informativo - se falhar, só não mostra o resumo de período dessa vez.
    }
}

function consultarGanhosDataEspecifica() {
    const data = document.getElementById('ganhos-data-especifica-input')?.value;
    if (!data) { alert('Escolha uma data primeiro.'); return; }
    carregarGanhosDetalhe(data);
}

// ---------- Aba Perfil ----------

function carregarPerfil() {
    if (!tokenAtual) return;
    // Reaproveita os dados que já vieram junto da última resposta de
    // entregas (nome, telefone, id) - não precisa de outra chamada.
    document.getElementById('perfil-nome').textContent = document.getElementById('nome-motoboy-header').textContent || '-';
    document.getElementById('perfil-telefone').textContent = motoboyTelefoneAtual || 'Telefone não cadastrado';
    document.getElementById('perfil-id').textContent = motoboyIdAtual ? `ID do entregador: ${motoboyIdAtual}` : '';
}

// ---------- Rastreio GPS em segundo plano (LocationTracking nativo) ----------
// Usa o plugin PRÓPRIO LocationTrackingPlugin (ver
// android/app/.../LocationTrackingPlugin.java e LocationTrackingService.java)
// - não depende mais do @capacitor-community/background-geolocation, que
// não estava mandando localização de forma confiável com o app
// minimizado ou a tela apagada. A diferença principal: agora é o próprio
// SERVIÇO NATIVO (Java) que manda a localização pro servidor direto via
// HTTP, sem passar pelo JavaScript/WebView - por isso continua
// funcionando de verdade com a tela apagada, já que não depende do
// WebView estar "acordado" pra nada.
//
// "Ficar Online"/"Ficar Offline" é uma escolha EXPLÍCITA do entregador
// (botão no topo da tela) - ao entrar no app já fica online automaticamente
// (comportamento de sempre), mas ele pode escolher ficar offline pra fazer
// uma pausa, por exemplo.

// Pede a permissão de notificação (POST_NOTIFICATIONS, só existe a partir
// do Android 13) - chamado uma vez a cada login/abertura do app. Se já
// tiver sido concedida (ou negada permanentemente) antes, o Android nem
// mostra a caixinha de novo, só devolve o estado; a notificação de
// entrega nova em si é mostrada pelo LocationTrackingService nativo (ver
// checarEntregasNovas lá), não daqui.
async function pedirPermissaoNotificacao() {
    const { LocationTracking } = pluginsCapacitor();
    if (!LocationTracking) return; // só existe no app nativo Android
    try {
        await LocationTracking.requestNotificationPermission();
    } catch (e) { /* aparelho recusou mostrar a caixinha - segue normal, só sem notificação de entrega nova nesse caso */ }
}

let entregadorEstaOnline = false;

async function ficarOnline() {
    const { LocationTracking } = pluginsCapacitor();
    if (!LocationTracking) {
        console.warn('Plugin LocationTracking não disponível (rodando fora do app nativo?).');
        return;
    }

    atualizarIndicadorGps('conectando');

    // 1) Confere se o GPS do aparelho está ligado (sem isso, nem adianta
    // ter permissão - o Android não vai entregar posição nenhuma).
    try {
        const statusGps = await LocationTracking.isGpsEnabled();
        if (!statusGps.enabled) {
            atualizarIndicadorGps('erro');
            alert('Ative a localização (GPS) do seu celular pra ficar online.');
            return;
        }
    } catch (e) { /* método pode falhar em versões antigas do Android - segue tentando mesmo assim */ }

    // 2) Confere/pede a permissão de localização normal ("Durante o uso do app").
    let permissoes = await LocationTracking.checkPermissions();
    if (permissoes.location !== 'granted') {
        permissoes = await LocationTracking.requestPermissions();
    }
    if (permissoes.location !== 'granted') {
        document.getElementById('aviso-permissao').classList.remove('hidden');
        atualizarIndicadorGps('sem-permissao');
        return;
    }
    document.getElementById('aviso-permissao').classList.add('hidden');

    // 3) Tenta pedir a permissão de segundo plano também (funciona de
    // verdade só no Android 10; do 11 em diante o Android não mostra essa
    // opção em nenhuma caixinha - por isso o aviso guiando pra
    // Configurações continua rodando de qualquer jeito, ver
    // verificarEavisarPermissaoSegundoPlano mais abaixo).
    try { await LocationTracking.requestBackgroundPermission(); } catch (e) { /* Android 11+ pode não conseguir mostrar isso - segue normalmente */ }

    // 4) Inicia o serviço nativo de verdade.
    try {
        await LocationTracking.startTracking({ token: tokenAtual, apiBase: API_BASE });
        entregadorEstaOnline = true;
        atualizarIndicadorGps('ativo');
        atualizarBotaoOnlineOffline();
        verificarEavisarPermissaoSegundoPlano();
    } catch (e) {
        console.error('Erro ao iniciar o rastreio:', e);
        atualizarIndicadorGps('erro');
    }
}

async function ficarOffline() {
    const { LocationTracking } = pluginsCapacitor();
    if (LocationTracking) {
        try { await LocationTracking.stopTracking(); } catch (e) { /* já parado */ }
    }
    entregadorEstaOnline = false;
    atualizarIndicadorGps('offline');
    atualizarBotaoOnlineOffline();
}

function alternarOnlineOffline() {
    if (entregadorEstaOnline) {
        if (confirm('Ficar offline? Você para de aparecer disponível pra novas entregas e a loja para de ver sua localização.')) {
            ficarOffline();
        }
    } else {
        ficarOnline();
    }
}

function atualizarBotaoOnlineOffline() {
    const botao = document.getElementById('botao-online-offline');
    if (!botao) return;
    botao.textContent = entregadorEstaOnline ? 'Ficar offline' : 'Ficar online';
    botao.className = entregadorEstaOnline
        ? 'text-xs font-semibold px-3 py-1.5 rounded-full bg-red-50 text-red-600 border border-red-200'
        : 'text-xs font-semibold px-3 py-1.5 rounded-full bg-green-50 text-green-700 border border-green-200';
}
// A PARTIR DO ANDROID 11, a opção "Permitir o tempo todo" NUNCA MAIS
// aparece na caixinha de permissão de localização normal (só "Durante o
// uso do app", "Apenas esta vez" e "Não permitir" - exatamente as 3
// opções que aparecem hoje) - o Google tirou essa opção de propósito da
// caixinha, por privacidade. A única forma de conseguir essa permissão
// agora é a pessoa entrar em Configurações do aparelho > apps > VTR
// Entregador > Permissões > Localização, e escolher "Permitir o tempo
// todo" manualmente lá dentro. Sem isso, o rastreio para de funcionar
// assim que a tela apaga ou o app é minimizado, mesmo com a notificação
// fixa configurada certinho - exatamente o sintoma relatado (GPS "some"
// do topo quando a tela apaga).
//
// A solução é mostrar um aviso claro guiando a pessoa até lá - mas SÓ
// quando a permissão realmente ainda não foi concedida. Antes, isso era
// controlado por uma flag salva no aparelho ("já avisei uma vez") que
// nunca era escrita em lugar nenhum - o aviso aparecia TODA VEZ que o
// app abria, mesmo com "Permitir o tempo todo" já ativado nas
// configurações. Agora confere o estado de verdade da permissão a cada
// vez (LocationTracking.checkPermissions() -> backgroundLocation) - só
// concedida de verdade faz o aviso parar de aparecer, não uma flag que
// podia ficar dessincronizada do que a pessoa realmente escolheu lá nas
// configurações do Android.
async function verificarEavisarPermissaoSegundoPlano() {
    const { LocationTracking } = pluginsCapacitor();
    if (!LocationTracking) return; // essa etapa só existe no app nativo Android

    let permissoes;
    try {
        permissoes = await LocationTracking.checkPermissions();
    } catch (e) {
        return; // não conseguiu checar agora - não incomoda com o aviso à toa.
    }
    if (permissoes.backgroundLocation === 'granted') return; // já ativado - nada a avisar.

    const modal = document.getElementById('modal-permissao-segundo-plano');
    if (modal) modal.classList.remove('hidden');
}

function fecharAvisoPermissaoSegundoPlano() {
    document.getElementById('modal-permissao-segundo-plano')?.classList.add('hidden');
    // Não precisa guardar nenhuma flag de "já avisei" - da próxima vez
    // que o app conectar o GPS, verificarEavisarPermissaoSegundoPlano
    // confere a permissão de novo, e só mostra o aviso se ainda não
    // tiver sido concedida de verdade.
}

// Leva a pessoa DIRETO pra tela de permissões do app - de lá, é só tocar
// em "Localização" e escolher "Permitir o tempo todo".
async function abrirConfiguracoesPermissaoSegundoPlano() {
    const { LocationTracking } = pluginsCapacitor();
    if (LocationTracking) {
        try { await LocationTracking.openAppSettings(); } catch (e) { /* aparelho bloqueou o atalho - a pessoa consegue abrir na mão também */ }
    }
    fecharAvisoPermissaoSegundoPlano();
}

function atualizarIndicadorGps(estado) {
    ultimoStatusGpsConhecido = estado; // guarda pra poder reaplicar quando o app voltar pra frente (ver configurarAtualizacaoAoVoltarParaFrente)
    const ponto = document.getElementById('ponto-gps');
    const texto = document.getElementById('texto-gps');
    const cores = {
        conectando: ['bg-slate-300', 'Conectando...'],
        ativo: ['bg-green-400', 'GPS ativo'],
        offline: ['bg-slate-300', 'Offline'],
        'sem-permissao': ['bg-red-400', 'Sem permissão'],
        erro: ['bg-red-400', 'Erro no GPS'],
    };
    const [cor, rotulo] = cores[estado] || cores.conectando;
    ponto.className = `w-2 h-2 rounded-full ${cor}`;
    texto.textContent = rotulo;
}

// ---------- Utilidade ----------

// Ícone de WhatsApp clicável (abre o wa.me direto com o número do
// cliente) - reaproveitado nos 3 lugares que mostram o telefone do
// cliente (lista de entregas, histórico e aba Mapa).
function linkWhatsappCliente(telefone) {
    if (!telefone) return '';
    const digitos = telefone.replace(/\D/g, '');
    const numeroCompleto = digitos.length <= 11 ? '55' + digitos : digitos;
    return `<a href="https://wa.me/${numeroCompleto}" target="_blank" onclick="event.stopPropagation()" title="Chamar no WhatsApp" class="inline-flex items-center justify-center w-4 h-4 align-text-bottom ml-1.5">
        <svg viewBox="0 0 24 24" fill="#25D366" class="w-full h-full"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2zm5.83 14.19c-.25.7-1.44 1.36-1.99 1.44-.51.08-1.15.11-1.86-.12-.43-.13-.98-.32-1.69-.62-2.98-1.29-4.93-4.28-5.08-4.48-.15-.2-1.21-1.61-1.21-3.07 0-1.46.77-2.18 1.04-2.48.27-.3.6-.37.8-.37.2 0 .4 0 .58.01.18.01.44-.07.68.53.25.6.86 2.07.93 2.22.07.15.12.33.02.53-.1.2-.15.33-.3.5-.15.18-.31.4-.44.53-.15.15-.3.31-.13.61.17.3.76 1.26 1.64 2.04 1.13 1 2.08 1.31 2.38 1.46.3.15.47.13.65-.08.17-.2.73-.85.93-1.15.2-.3.4-.24.66-.15.27.1 1.73.82 2.02.97.3.15.49.22.57.35.07.13.07.75-.18 1.45z"/></svg>
    </a>`;
}

function escapeHtml(texto) {
    const div = document.createElement('div');
    div.textContent = texto ?? '';
    return div.innerHTML;
}

// ---------- Inicialização ----------

document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('aviso-permissao').addEventListener('click', async () => {
        const { LocationTracking } = pluginsCapacitor();
        if (LocationTracking) await LocationTracking.openAppSettings();
    });

    const tokenSalvo = await lerTokenLocal();
    if (tokenSalvo) {
        try {
            const resposta = await fetch(`${API_BASE}/motoboy_minhas_entregas.php?token=${encodeURIComponent(tokenSalvo)}`);
            const resultado = await resposta.json();
            if (resultado.status === 'sucesso') {
                await iniciarAppLogado(tokenSalvo, resultado.motoboy_nome);
                return;
            }
        } catch (e) {
            // Sem internet no momento em que abriu o app - ainda assim entra
            // logado (o token já foi validado antes), só a lista de entregas
            // fica vazia até a conexão voltar.
            await iniciarAppLogado(tokenSalvo, '');
            return;
        }
        // Token salvo não é mais válido (motoboy desativado, etc.)
        await apagarTokenLocal();
    }
    mostrarTela('tela-login');
});
