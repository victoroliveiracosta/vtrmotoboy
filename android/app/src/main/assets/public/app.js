// ---------------------------------------------------------------------
// VTR Motoboy - app do entregador.
// Sem bundler de propósito (mesmo estilo do resto do VTR PDV): os
// plugins nativos do Capacitor ficam disponíveis direto em
// window.Capacitor.Plugins, sem precisar importar/empacotar nada.
// ---------------------------------------------------------------------

const API_BASE = 'https://vtrpdv.com/api';
const CHAVE_TOKEN = 'vtr_motoboy_token';

let tokenAtual = null;
let watcherIdGps = null;
let intervalAtualizarEntregas = null;

function pluginsCapacitor() {
    return (window.Capacitor && window.Capacitor.Plugins) || {};
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
    pararRastreioGps();
    if (intervalAtualizarEntregas) clearInterval(intervalAtualizarEntregas);
    apagarTokenLocal();
    tokenAtual = null;
    document.getElementById('input-token-login').value = '';
    mostrarTela('tela-login');
}

// ---------- App logado ----------

async function iniciarAppLogado(token, nomeMotoboy) {
    tokenAtual = token;
    document.getElementById('nome-motoboy-header').textContent = nomeMotoboy || 'Motoboy';
    mostrarTela('tela-principal');

    await iniciarRastreioGps();
    await carregarEntregas();

    // Atualiza a lista de entregas sozinha de tempos em tempos, pra
    // aparecer uma entrega nova sem precisar fechar e abrir o app.
    if (intervalAtualizarEntregas) clearInterval(intervalAtualizarEntregas);
    intervalAtualizarEntregas = setInterval(carregarEntregas, 30000);
}

// ---------- Entregas ----------

async function carregarEntregas() {
    if (!tokenAtual) return;
    const lista = document.getElementById('lista-entregas');

    try {
        const resposta = await fetch(`${API_BASE}/motoboy_minhas_entregas.php?token=${encodeURIComponent(tokenAtual)}`);
        const resultado = await resposta.json();

        if (resultado.status !== 'sucesso') {
            lista.innerHTML = `<p class="text-center text-slate-400 py-10 text-sm">${escapeHtml(resultado.mensagem || 'Erro ao carregar entregas.')}</p>`;
            return;
        }

        renderizarEntregas(resultado.entregas || []);
    } catch (e) {
        // Falha de rede isolada não precisa incomodar - só mantém a lista antiga na tela.
    }
}

function renderizarEntregas(entregas) {
    const lista = document.getElementById('lista-entregas');
    if (entregas.length === 0) {
        lista.innerHTML = '<p class="text-center text-slate-400 py-10 text-sm">Nenhuma entrega no momento. 🎉</p>';
        return;
    }

    lista.innerHTML = entregas.map(e => `
        <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <p class="font-bold text-slate-800">${escapeHtml(e.cliente_nome || 'Cliente')}</p>
            <p class="text-xs text-slate-400 mb-1">${escapeHtml(e.cliente_telefone || '')}</p>
            <p class="text-sm text-slate-600 mb-3">📍 ${escapeHtml(e.endereco_entrega || 'Endereço não informado')}</p>
            <div class="flex items-center justify-between gap-2">
                <span class="font-bold text-slate-800">R$ ${parseFloat(e.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                <div class="flex gap-2">
                    <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(e.endereco_entrega || '')}" target="_blank" class="bg-slate-100 text-slate-600 px-3 py-2 rounded-lg text-xs font-bold">🗺️ Rota</a>
                    <button onclick="marcarEntregue('${e.id}')" class="bg-green-600 hover:bg-green-700 text-white px-3 py-2 rounded-lg text-xs font-bold">✓ Entregue</button>
                </div>
            </div>
        </div>
    `).join('');
}

async function marcarEntregue(vendaId) {
    if (!confirm('Confirmar que essa entrega foi feita?')) return;
    try {
        const resposta = await fetch(`${API_BASE}/motoboy_marcar_entregue.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenAtual, venda_id: vendaId }),
        });
        const resultado = await resposta.json();
        if (resultado.status === 'sucesso') {
            carregarEntregas();
        } else {
            alert(resultado.mensagem || 'Não foi possível marcar como entregue.');
        }
    } catch (e) {
        alert('Erro de conexão. Tente de novo.');
    }
}

// ---------- Rastreio GPS em segundo plano ----------
// "backgroundMessage" preenchido faz o Android manter uma notificação
// fixa e continuar mandando localização mesmo com a tela apagada ou o
// app em segundo plano - é essa notificação que garante que o sistema
// operacional não mate o processo, diferente de um site/PWA comum.

async function iniciarRastreioGps() {
    const { BackgroundGeolocation } = pluginsCapacitor();
    if (!BackgroundGeolocation) {
        console.warn('Plugin de geolocalização não disponível (rodando fora do app nativo?).');
        return;
    }

    atualizarIndicadorGps('conectando');

    try {
        watcherIdGps = await BackgroundGeolocation.addWatcher(
            {
                backgroundTitle: 'VTR Motoboy - Entrega em andamento',
                backgroundMessage: 'Compartilhando sua localização com a loja durante a entrega.',
                requestPermissions: true,
                distanceFilter: 15, // só manda atualização se andar uns 15m - economiza bateria/dados
            },
            (posicao, erro) => {
                if (erro) {
                    if (erro.code === 'NOT_AUTHORIZED') {
                        document.getElementById('aviso-permissao').classList.remove('hidden');
                        atualizarIndicadorGps('sem-permissao');
                    }
                    return;
                }
                document.getElementById('aviso-permissao').classList.add('hidden');
                atualizarIndicadorGps('ativo');
                if (posicao) {
                    enviarLocalizacaoServidor(posicao.latitude, posicao.longitude);
                }
            }
        );
    } catch (e) {
        console.error('Erro ao iniciar rastreio GPS:', e);
        atualizarIndicadorGps('erro');
    }
}

async function pararRastreioGps() {
    const { BackgroundGeolocation } = pluginsCapacitor();
    if (BackgroundGeolocation && watcherIdGps) {
        try { await BackgroundGeolocation.removeWatcher({ id: watcherIdGps }); } catch (e) { /* já parado */ }
        watcherIdGps = null;
    }
}

async function enviarLocalizacaoServidor(latitude, longitude) {
    if (!tokenAtual) return;
    try {
        await fetch(`${API_BASE}/atualizar_localizacao_motoboy.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenAtual, latitude, longitude }),
        });
    } catch (e) {
        // Falha isolada de rede não é grave - a próxima posição corrige sozinha.
    }
}

function atualizarIndicadorGps(estado) {
    const ponto = document.getElementById('ponto-gps');
    const texto = document.getElementById('texto-gps');
    const cores = {
        conectando: ['bg-slate-400', 'Conectando...'],
        ativo: ['bg-green-400', 'GPS ativo'],
        'sem-permissao': ['bg-red-400', 'Sem permissão'],
        erro: ['bg-red-400', 'Erro no GPS'],
    };
    const [cor, rotulo] = cores[estado] || cores.conectando;
    ponto.className = `w-2 h-2 rounded-full ${cor}`;
    texto.textContent = rotulo;
}

// ---------- Utilidade ----------

function escapeHtml(texto) {
    const div = document.createElement('div');
    div.textContent = texto ?? '';
    return div.innerHTML;
}

// ---------- Inicialização ----------

document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('aviso-permissao').addEventListener('click', async () => {
        const { BackgroundGeolocation } = pluginsCapacitor();
        if (BackgroundGeolocation) await BackgroundGeolocation.openSettings();
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
