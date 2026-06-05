/**
 * Mascote Interativo de Login - Data Runner (Papa-léguas Clássico GoldenLens)
 * Encapsula de forma limpa e isolada todos os estilos, HTML e comportamentos do mascote.
 */

document.addEventListener('DOMContentLoaded', () => {
  const loginCard = document.querySelector('.login');
  if (!loginCard) return;

  // 1. Injetar Estilos CSS do Mascote e Ticks
  const style = document.createElement('style');
  style.textContent = `
    /* Estilos do Mascote Interativo (Papa-léguas) */
    .login-wrapper {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-top: 110px; /* Dá espaço generoso para o mascote acima */
      margin-bottom: 20px;
      width: 100%;
      position: relative;
    }
    
    .mascot-container {
      width: 260px;
      height: 180px;
      position: absolute;
      top: -128px; /* Deita perfeitamente em cima da caixa de login */
      left: 50%;
      transform: translateX(-50%);
      pointer-events: none;
      user-select: none;
      z-index: 10;
    }

    /* Ajuste no layout do body */
    body {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      min-height: 100dvh;
      background: radial-gradient(1200px 600px at 50% -10%, rgba(37, 99, 235, 0.16), transparent 70%), var(--bg-0);
      overflow-x: hidden;
      overflow-y: auto;
      padding: 20px 0;
      padding-top: max(20px, env(safe-area-inset-top, 0));
      padding-bottom: max(20px, env(safe-area-inset-bottom, 0));
    }

    .login {
      position: relative;
      width: min(420px, calc(100vw - 32px));
      background: var(--bg-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-2);
      padding: 32px 28px;
    }

    @media (max-width: 480px) {
      .login-wrapper {
        margin-top: 88px;
        margin-bottom: 12px;
      }
      .mascot-container {
        width: 210px;
        height: 145px;
        top: -108px;
      }
      .login {
        padding: 24px 20px;
      }
    }

    /* Leve flutuação do Papa-léguas para dar sensação de respiração e vida */
    @keyframes runnerBreathing {
      0%, 100% {
        transform: translateY(0px) scaleY(1);
      }
      50% {
        transform: translateY(-2.5px) scaleY(0.97);
      }
    }
    
    #lizard {
      animation: runnerBreathing 3s ease-in-out infinite;
      transform-origin: 116px 115px;
    }

    /* Animação de Corrida / Dash Horizontal do Papa-léguas (Dados Bons) */
    @keyframes runnerDash {
      0% {
        transform: translateX(0px) scaleX(1) skewX(0deg);
      }
      15% {
        /* Prepara para correr: agacha e puxa para trás */
        transform: translateX(-20px) scaleY(0.85) scaleX(1.1) skewX(-10deg);
      }
      30% {
        /* Dispara para frente em alta velocidade (esticado) */
        transform: translateX(95px) scaleY(0.95) scaleX(1.15) skewX(20deg);
      }
      55% {
        /* Chega no alvo e freia (inclinando para trás) */
        transform: translateX(110px) scaleY(1.05) scaleX(0.9) skewX(-15deg);
      }
      75% {
        /* Começa a retornar de costas correndo rápido */
        transform: translateX(35px) scaleX(0.98) skewX(5deg);
      }
      100% {
        /* Retorna suave à posição normal */
        transform: translateX(0px) scaleX(1) skewX(0deg);
      }
    }
    
    .runner-dashing {
      animation: runnerDash 0.65s cubic-bezier(0.25, 0.46, 0.45, 0.94) !important;
      animation-fill-mode: forwards;
    }

    /* Animação de Pulo / Salto Vertical do Papa-léguas (Desvio de Dados Ruins) */
    @keyframes runnerJump {
      0% {
        transform: translateY(0px) scaleY(1);
      }
      15% {
        /* Agacha para pegar impulso */
        transform: translateY(10px) scaleY(0.78) scaleX(1.1);
      }
      40% {
        /* Pula alto verticalmente */
        transform: translateY(-80px) scaleY(1.1) scaleX(0.95);
      }
      65% {
        /* Flutua ligeiramente no topo do pulo */
        transform: translateY(-85px) scaleY(1) scaleX(1);
      }
      85% {
        /* Pousa e amortece o impacto */
        transform: translateY(12px) scaleY(0.78) scaleX(1.1);
      }
      100% {
        /* Retorna à posição original */
        transform: translateY(0px) scaleY(1) scaleX(1);
      }
    }

    .runner-jumping {
      animation: runnerJump 0.65s cubic-bezier(0.25, 0.46, 0.45, 0.94) !important;
      animation-fill-mode: forwards;
    }

    /* Animação do Beep Beep autônomo */
    @keyframes runnerBeep {
      0%, 100% {
        transform: scale(1) rotate(0deg);
      }
      20% {
        /* Inclina o pescoço e abre o peito para o Beep Beep */
        transform: scaleX(1.05) rotate(4deg) translateY(2px);
      }
      40% {
        /* Movimento rápido 1 */
        transform: scaleX(1.08) rotate(-2deg) translateY(-2px);
      }
      60% {
        /* Movimento rápido 2 */
        transform: scaleX(1.08) rotate(3deg) translateY(1px);
      }
      80% {
        transform: scale(1.02) rotate(0deg);
      }
    }

    .runner-beeping {
      animation: runnerBeep 0.8s ease-in-out !important;
      animation-fill-mode: forwards;
    }

    /* Rotação rápida do redemoinho de pernas */
    @keyframes spinLegs {
      0% {
        transform: rotate(0deg);
      }
      100% {
        transform: rotate(360deg);
      }
    }

    /* Quando correndo ou pulando, oculta pernas estáticas e mostra o redemoinho girando com blur */
    .runner-dashing #legs-static, .runner-jumping #legs-static {
      display: none !important;
    }
    .runner-dashing #legs-running, .runner-jumping #legs-running {
      display: block !important;
      animation: spinLegs 0.08s linear infinite !important;
    }

    /* Animação sutil da cauda de penas balançando */
    @keyframes tailWiggle {
      0%, 100% {
        transform: rotate(0deg);
      }
      50% {
        transform: rotate(-4deg);
      }
    }
    #lizard-tail {
      animation: tailWiggle 3.5s ease-in-out infinite;
      transform-origin: 90px 115px;
    }
  `;
  document.head.appendChild(style);

  // 2. Embrulhar dinamicamente a caixa de login em um wrapper se não estiver embrulhado
  let wrapper = document.querySelector('.login-wrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'login-wrapper';
    loginCard.parentNode.insertBefore(wrapper, loginCard);
    wrapper.appendChild(loginCard);
  }

  // 3. Criar e injetar o SVG do Papa-léguas (Data Runner)
  const mascotContainer = document.createElement('div');
  mascotContainer.className = 'mascot-container';
  mascotContainer.innerHTML = `
    <svg id="mascot" width="260" height="180" viewBox="0 0 260 180" style="overflow: visible;">
      <defs>
        <!-- Gradiente do corpo do Papa-léguas (Azul Cobalto Clássico) -->
        <linearGradient id="bodyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#2563eb" />
          <stop offset="100%" stop-color="#1e3a8a" />
        </linearGradient>

        <!-- Gradiente das bochechas/bico/pernas (Amarelo Looney Tunes para Ocre/Laranja) -->
        <linearGradient id="beakGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#fbbf24" />
          <stop offset="100%" stop-color="#f59e0b" />
        </linearGradient>

        <!-- Laranja para partes do bico e plumas -->
        <linearGradient id="orangeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#f97316" />
          <stop offset="100%" stop-color="#ea580c" />
        </linearGradient>

        <!-- Gradiente dourado para as pupilas/íris (GoldenLens) -->
        <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ffe259" />
          <stop offset="100%" stop-color="#ffa751" />
        </linearGradient>

        <!-- Gradiente branco para peito e barriga -->
        <linearGradient id="whiteGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#ffffff" />
          <stop offset="100%" stop-color="#f1f5f9" />
        </linearGradient>
      </defs>

      <!-- Grupo do Papa-léguas (Data Runner) -->
      <g id="lizard" style="transform-origin: 116px 115px;">
        <!-- Cauda de Penas (id lizard-tail para balançar) -->
        <g id="lizard-tail">
          <!-- Pena superior -->
          <path d="M 88,116 C 58,110 36,86 24,56 C 36,74 58,96 88,110 Z" fill="url(#bodyGrad)" stroke="#1e3a8a" stroke-width="1.2" />
          <!-- Pena do meio -->
          <path d="M 90,118 C 55,120 32,102 18,78 C 32,92 55,108 90,112 Z" fill="url(#bodyGrad)" stroke="#1e3a8a" stroke-width="1.2" />
          <!-- Pena inferior (detalhe laranja na cauda) -->
          <path d="M 90,120 C 50,130 28,118 12,98 C 28,108 50,118 90,114 Z" fill="url(#orangeGrad)" opacity="0.95" />
        </g>

        <!-- Pernas Estáticas (Longas, finas e clássicas do desenho) -->
        <g id="legs-static">
          <!-- Perna esquerda (traseira) -->
          <path d="M 104,130 L 102,156 M 102,156 L 86,160 M 102,156 L 102,164 M 102,156 L 112,160" fill="none" stroke="url(#beakGrad)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          <!-- Perna direita (dianteira) -->
          <path d="M 120,130 L 118,156 M 118,156 L 102,160 M 118,156 L 118,164 M 118,156 L 128,160" fill="none" stroke="url(#beakGrad)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        </g>

        <!-- Pernas Correndo / Redemoinho (Display none por padrão) -->
        <g id="legs-running" style="display: none; transform-origin: 116px 145px;">
          <ellipse cx="116" cy="145" rx="32" ry="16" fill="none" stroke="#fbbf24" stroke-width="4.5" stroke-dasharray="12 6" opacity="0.9" />
          <ellipse cx="116" cy="145" rx="16" ry="32" fill="none" stroke="#f97316" stroke-width="4" stroke-dasharray="10 5" opacity="0.8" />
          <ellipse cx="116" cy="145" rx="26" ry="26" fill="none" stroke="#ea580c" stroke-width="3" stroke-dasharray="18 8" opacity="0.75" />
        </g>

        <!-- Corpo Oval Aerodinâmico -->
        <ellipse cx="114" cy="118" rx="28" ry="16" fill="url(#bodyGrad)" stroke="#1e3a8a" stroke-width="1.8" />
        
        <!-- Detalhe do Peito Branco -->
        <path d="M 104,106 C 114,106 128,110 128,118 C 128,126 114,132 104,124 Z" fill="url(#whiteGrad)" opacity="0.95" />

        <!-- Asas Azuis-Escuras na lateral -->
        <path d="M 96,110 C 82,110 70,122 62,134 C 76,131 92,122 114,116 Z" fill="#1e3a8a" stroke="#2563eb" stroke-width="1.2" />
        <!-- Detalhe da pena de asa (azul claro) -->
        <path d="M 88,114 C 78,116 72,122 68,128 C 76,125 84,120 94,117 Z" fill="#60a5fa" opacity="0.95" />

        <!-- Pescoço Longo e Fino Clássico -->
        <path d="M 116,104 C 120,80 128,62 138,48 L 145,51 C 135,66 127,84 122,106 Z" fill="url(#bodyGrad)" />

        <!-- Cabeça -->
        <ellipse cx="140" cy="45" rx="11" ry="9" fill="url(#bodyGrad)" stroke="#1e3a8a" stroke-width="1.5" />

        <!-- Crista de Penas Clássicas do Desenho (Compridas e curvadas para trás) -->
        <path d="M 134,38 C 120,24 106,16 92,14 C 108,20 122,30 134,38 Z" fill="url(#bodyGrad)" stroke="#1e3a8a" stroke-width="1.2" />
        <path d="M 137,38 C 124,20 112,10 98,6 C 112,13 124,24 137,38 Z" fill="#1d4ed8" />
        <path d="M 140,39 C 131,22 122,14 110,8 C 121,15 131,25 140,39 Z" fill="#3b82f6" />

        <!-- Olhos Expressivos ovais brancos colados (Looney Tunes Style) -->
        <ellipse cx="137" cy="36" rx="5.5" ry="9" fill="#ffffff" stroke="#1e3a8a" stroke-width="1.2" />
        <ellipse cx="147" cy="35" rx="5.5" ry="9" fill="#ffffff" stroke="#1e3a8a" stroke-width="1.2" />

        <!-- pupilas para rastreamento ocular -->
        <g id="lizard-pupil" style="transition: transform 0.12s ease-out;">
          <!-- Pupila esquerda -->
          <ellipse cx="138" cy="38" rx="2.5" ry="4" fill="#000000" />
          <circle cx="137.2" cy="36.5" r="0.8" fill="#ffffff" />
          <!-- Pupila direita -->
          <ellipse cx="147.2" cy="37" rx="2.5" ry="4" fill="#000000" />
          <circle cx="146.4" cy="35.5" r="0.8" fill="#ffffff" />
        </g>

        <!-- Bochecha/Bico Inferior (Amarelo Looney Tunes) -->
        <ellipse cx="136" cy="46" rx="8" ry="5" fill="url(#beakGrad)" />

        <!-- Bico Superior Laranja/Amarelo -->
        <path d="M 141,41 Q 162,38 168,43 Q 155,49 141,47 Z" fill="url(#orangeGrad)" stroke="#c2410c" stroke-width="1" />
        <!-- Linha da boca -->
        <path d="M 140,44 L 164,44" fill="none" stroke="#7c2d12" stroke-width="1" />

        <!-- Elementos ocultos para manter compatibilidade retroativa -->
        <path id="lizard-tongue" d="M 140,45 Q 140,45 140,45" fill="none" opacity="0" display="none" />
        <circle id="lizard-tongue-tip" cx="140" cy="45" r="1" fill="none" opacity="0" display="none" />
      </g>
    </svg>
  `;
  wrapper.insertBefore(mascotContainer, loginCard);

  // 4. Lógica de Rastreamento Ocular e Comportamento das Partículas de Ticks
  const mascot = document.getElementById('mascot');
  const pupil = document.getElementById('lizard-pupil');
  
  let isHunting = false;
  let isJumping = false;
  let lastMouseMoveTime = Date.now();
  let idleEyeTimer = null;

  // Atualização das pupilas com base no mouse (coordenada central X=142, Y=35.5)
  function updatePupil(targetX, targetY) {
    if (!pupil || !mascot || isHunting || isJumping) return;
    
    const rect = mascot.getBoundingClientRect();
    const scaleX = rect.width / 260;
    const scaleY = rect.height / 180;
    
    const eyeCenterX = rect.left + 142 * scaleX;
    const eyeCenterY = rect.top + 35.5 * scaleY;
    
    const dx = targetX - eyeCenterX;
    const dy = targetY - eyeCenterY;
    const distance = Math.hypot(dx, dy);
    
    const maxOffset = 2.2;
    const intensity = Math.min(distance / 200, 1);
    
    const angle = Math.atan2(dy, dx);
    const px = Math.cos(angle) * maxOffset * intensity;
    const py = Math.sin(angle) * maxOffset * intensity;
    
    pupil.style.transform = `translate(${px}px, ${py}px)`;
  }

  document.addEventListener('mousemove', (event) => {
    lastMouseMoveTime = Date.now();
    
    if (idleEyeTimer) {
      clearInterval(idleEyeTimer);
      idleEyeTimer = null;
    }
    
    updatePupil(event.clientX, event.clientY);
  });

  // Loop de movimento ocular autônomo quando inativo (vigilância)
  function startIdleEyes() {
    if (idleEyeTimer) return;
    
    idleEyeTimer = setInterval(() => {
      if (Date.now() - lastMouseMoveTime < 3000 || isHunting || isJumping) return;
      
      const angle = Math.random() * Math.PI * 2;
      const offset = Math.random() * 2.2;
      const px = Math.cos(angle) * offset;
      const py = Math.sin(angle) * offset;
      
      if (pupil) {
        pupil.style.transform = `translate(${px}px, ${py}px)`;
        
        // Piscada de olhos
        if (Math.random() < 0.22) {
          pupil.style.transform += ' scaleY(0.1)';
          setTimeout(() => {
            pupil.style.transform = pupil.style.transform.replace(' scaleY(0.1)', '');
          }, 150);
        }
      }
    }, 1200 + Math.random() * 1500);
  }
  
  // Liga o monitorador de inatividade
  setInterval(() => {
    if (Date.now() - lastMouseMoveTime >= 3000) {
      startIdleEyes();
    }
  }, 1000);

  // 5. Fluxo Contínuo de Partículas de Ticks de Alta Velocidade
  const activeBugs = new Set();
  
  function createBug() {
    if (activeBugs.size >= 5) return; // Limite de 5 ticks simultâneos na tela
    
    const isGold = Math.random() < 0.25; // 25% de chance de ser sinal dourado (alvo de dash)
    const isUp = Math.random() < 0.45;  // 45% de chance de ser sinal verde (alvo de dash)
    
    const tick = document.createElement('div');
    tick.className = 'data-bug';
    wrapper.appendChild(tick);
    
    // Customização visual dinâmica das partículas (Tabela de Ticks/OHLC do Backtest)
    tick.style.width = '16px';
    tick.style.height = '16px';
    tick.style.borderRadius = '4px';
    tick.style.position = 'absolute';
    tick.style.display = 'flex';
    tick.style.alignItems = 'center';
    tick.style.justifyContent = 'center';
    tick.style.fontFamily = 'var(--font-mono)';
    tick.style.fontSize = '9px';
    tick.style.fontWeight = '800';
    tick.style.transition = 'opacity 0.2s, transform 0.2s';
    tick.style.zIndex = '5';
    
    if (isGold) {
      tick.style.background = 'rgba(255, 122, 0, 0.25)';
      tick.style.border = '2px solid #ff7a00';
      tick.style.color = '#ffe259';
      tick.style.boxShadow = '0 0 10px #ff7a00';
      tick.textContent = '★';
    } else if (isUp) {
      tick.style.background = 'rgba(16, 185, 129, 0.2)';
      tick.style.border = '1.5px solid #10b981';
      tick.style.color = '#10b981';
      tick.style.boxShadow = '0 0 6px rgba(16, 185, 129, 0.5)';
      tick.textContent = '▲';
    } else {
      tick.style.background = 'rgba(239, 68, 68, 0.2)';
      tick.style.border = '1.5px solid #ef4444';
      tick.style.color = '#ef4444';
      tick.style.boxShadow = '0 0 6px rgba(239, 68, 68, 0.5)';
      tick.textContent = '▼';
    }
    
    const wrapperWidth = wrapper.offsetWidth;
    const x = wrapperWidth + 20; // Nasce do lado direito
    // Passa horizontalmente logo abaixo do mascote (Y=-10 a Y=30px em relação ao topo do card)
    const y = -10 + Math.random() * 40; 
    
    const bugData = {
      element: tick,
      x: x,
      y: y,
      speed: 3.5 + Math.random() * 3.0, // Ticks de alta velocidade
      createdAt: Date.now(),
      isGold: isGold,
      isUp: isUp,
      isGood: isGold || isUp,
      isBad: !isGold && !isUp,
      targetApproached: false
    };
    
    activeBugs.add(bugData);
  }

  // Atualização linear/horizontal das partículas
  function updateBugs() {
    const wrapperWidth = wrapper.offsetWidth;
    
    activeBugs.forEach((bug) => {
      // Remove se cruzar a tela inteira para a esquerda
      if (bug.x < -40) {
        bug.element.remove();
        activeBugs.delete(bug);
        return;
      }

      // Se o tick estiver perto da zona de ativação central e o mascote estiver livre:
      if (!bug.targetApproached && !isHunting && !isJumping) {
        const triggerX = wrapperWidth / 2 - 20; // Ponto central
        
        if (bug.x <= triggerX + 40 && bug.x >= triggerX - 40) {
          bug.targetApproached = true;
          
          if (bug.isGood) {
            triggerCapture(bug); // Ataca dados bons (dash horizontal)
          } else {
            triggerEvade(bug); // Pula dados ruins (salto de esquiva)
          }
        } else {
          bug.x -= bug.speed;
        }
      } else {
        bug.x -= bug.speed;
      }

      bug.element.style.left = `${bug.x}px`;
      bug.element.style.top = `${bug.y}px`;
      
      // Papa-léguas olha para o tick se estiver por perto
      if (!isHunting && !isJumping && pupil) {
        const rect = mascot.getBoundingClientRect();
        const scaleX = rect.width / 260;
        
        const mascotRect = mascot.getBoundingClientRect();
        const bugRect = bug.element.getBoundingClientRect();
        const bugLocalX = (bugRect.left - mascotRect.left) * scaleX;
        
        if (bugLocalX > 40 && bugLocalX < 200 && Math.random() < 0.15) {
          const dx = bugLocalX - 142;
          const px = Math.max(-2.2, Math.min(2.2, dx / 25));
          pupil.style.transform = `translate(${px}px, 0px)`;
        }
      }
    });
    
    requestAnimationFrame(updateBugs);
  }

  // Captura de Tick: Animação de Dash Horizontal (Dados Bons)
  function triggerCapture(bugData) {
    if (isHunting || isJumping) return;
    isHunting = true;
    
    const bugEl = bugData.element;
    const lizardEl = document.getElementById('lizard');
    if (!lizardEl) return;
    
    // 1. Executa o Dash (CSS class)
    lizardEl.classList.add('runner-dashing');
    
    // 2. Colisão no pico do dash / impacto sobre a partícula (300ms)
    setTimeout(() => {
      // Oculta e desintegra a partícula
      bugEl.style.transform = 'scale(0)';
      bugEl.style.opacity = '0';
      
      // Cria faíscas douradas e verdes no ponto de colisão
      createSparkExplosion(bugData.x + 8, bugData.y + 8);
      
      // Exibe tag de ganho flutuante (GAIN / BUY / EDGE)
      createGainTag(bugData.x, bugData.y - 12);
      
      setTimeout(() => {
        bugEl.remove();
        activeBugs.delete(bugData);
      }, 150);
      
    }, 300);
    
    // 3. Fim do dash (650ms) e reset
    setTimeout(() => {
      lizardEl.classList.remove('runner-dashing');
      isHunting = false;
      
      // Pequena chance de comemorar com Beep Beep!
      if (Math.random() < 0.25) {
        showSpeechBubble('BEEP! BEEP!');
      }
    }, 650);
  }

  // Esquiva de Tick Ruim: Animação de Salto Vertical
  function triggerEvade(bugData) {
    if (isJumping || isHunting) return;
    isJumping = true;
    
    const lizardEl = document.getElementById('lizard');
    if (!lizardEl) return;
    
    // 1. Executa o Salto (CSS class)
    lizardEl.classList.add('runner-jumping');
    
    // 2. Feedback visual de desvio após atingir o pico (250ms)
    setTimeout(() => {
      createAvoidTag(bugData.x, bugData.y - 12);
    }, 250);
    
    // 3. Fim do pulo (650ms) e reset
    setTimeout(() => {
      lizardEl.classList.remove('runner-jumping');
      isJumping = false;
    }, 650);
  }

  // Criação de faíscas neon coloridas na desintegração do sinal
  function createSparkExplosion(centerX, centerY) {
    for (let i = 0; i < 9; i++) {
      const spark = document.createElement('div');
      spark.style.position = 'absolute';
      spark.style.width = '4px';
      spark.style.height = '4px';
      spark.style.borderRadius = '50%';
      spark.style.background = Math.random() < 0.6 ? '#ffe259' : '#10b981';
      spark.style.boxShadow = '0 0 5px currentColor';
      spark.style.left = `${centerX}px`;
      spark.style.top = `${centerY}px`;
      spark.style.pointerEvents = 'none';
      spark.style.zIndex = '6';
      wrapper.appendChild(spark);
      
      const angle = Math.random() * Math.PI * 2;
      const velocity = 1.5 + Math.random() * 3.0;
      const vx = Math.cos(angle) * velocity;
      const vy = Math.sin(angle) * velocity;
      
      let x = centerX;
      let y = centerY;
      let opacity = 1;
      
      function animateSpark() {
        x += vx;
        y += vy;
        opacity -= 0.05;
        
        spark.style.left = `${x}px`;
        spark.style.top = `${y}px`;
        spark.style.opacity = opacity;
        
        if (opacity > 0) {
          requestAnimationFrame(animateSpark);
        } else {
          spark.remove();
        }
      }
      requestAnimationFrame(animateSpark);
    }
  }

  // Tag flutuante que sobe simulando métricas positivas do Backtest
  const tags = ['GAIN!', 'BUY!', 'EDGE!', '+12.4%', 'PROFIT!', 'DUCKDB!', 'BACKTEST OK', '+18.6%'];
  function createGainTag(x, y) {
    const tag = document.createElement('div');
    tag.style.position = 'absolute';
    tag.style.left = `${x - 20}px`;
    tag.style.top = `${y}px`;
    tag.style.color = '#10b981';
    tag.style.fontFamily = 'var(--font-mono)';
    tag.style.fontSize = '9.5px';
    tag.style.fontWeight = '900';
    tag.style.textShadow = '0 0 6px rgba(16, 185, 129, 0.8)';
    tag.style.pointerEvents = 'none';
    tag.style.zIndex = '6';
    tag.style.transition = 'transform 0.9s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.9s';
    tag.textContent = tags[Math.floor(Math.random() * tags.length)];
    wrapper.appendChild(tag);
    
    setTimeout(() => {
      tag.style.transform = 'translateY(-35px) scale(1.15)';
      tag.style.opacity = '0';
    }, 20);
    
    setTimeout(() => {
      tag.remove();
    }, 950);
  }

  // Tag flutuante vermelha que indica que o dado ruim foi pulado/ignorado
  function createAvoidTag(x, y) {
    const tag = document.createElement('div');
    tag.style.position = 'absolute';
    tag.style.left = `${x - 20}px`;
    tag.style.top = `${y}px`;
    tag.style.color = '#ef4444';
    tag.style.fontFamily = 'var(--font-mono)';
    tag.style.fontSize = '9px';
    tag.style.fontWeight = '900';
    tag.style.textShadow = '0 0 6px rgba(239, 68, 68, 0.8)';
    tag.style.pointerEvents = 'none';
    tag.style.zIndex = '6';
    tag.style.transition = 'transform 0.8s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.8s';
    tag.textContent = 'SKIP TICK';
    wrapper.appendChild(tag);
    
    setTimeout(() => {
      tag.style.transform = 'translateY(-25px) scale(1.1)';
      tag.style.opacity = '0';
    }, 20);
    
    setTimeout(() => {
      tag.remove();
    }, 850);
  }

  // Balão de fala do Papa-léguas acima de sua cabeça
  function showSpeechBubble(text) {
    const oldBubble = mascotContainer.querySelector('.speech-bubble');
    if (oldBubble) oldBubble.remove();

    const bubble = document.createElement('div');
    bubble.className = 'speech-bubble';
    bubble.textContent = text;
    
    bubble.style.position = 'absolute';
    bubble.style.top = '-20px';
    bubble.style.left = '60%';
    bubble.style.transform = 'translate(-50%, -20px) scale(0.8)';
    bubble.style.opacity = '0';
    bubble.style.background = 'rgba(15, 23, 42, 0.92)';
    bubble.style.border = '1.5px solid #fbbf24';
    bubble.style.color = '#ffffff';
    bubble.style.fontWeight = '900';
    bubble.style.fontSize = '12px';
    bubble.style.fontFamily = 'var(--font-sans)';
    bubble.style.padding = '6px 12px';
    bubble.style.borderRadius = '12px';
    bubble.style.boxShadow = '0 0 15px rgba(251, 191, 36, 0.35), 0 4px 10px rgba(0, 0, 0, 0.5)';
    bubble.style.pointerEvents = 'none';
    bubble.style.whiteSpace = 'nowrap';
    bubble.style.zIndex = '20';
    bubble.style.transition = 'transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.2s';
    
    const arrow = document.createElement('div');
    arrow.style.position = 'absolute';
    arrow.style.bottom = '-6px';
    arrow.style.left = '45%';
    arrow.style.width = '0';
    arrow.style.height = '0';
    arrow.style.borderLeft = '6px solid transparent';
    arrow.style.borderRight = '6px solid transparent';
    arrow.style.borderTop = '6.5px solid #fbbf24';
    bubble.appendChild(arrow);

    mascotContainer.appendChild(bubble);
    
    setTimeout(() => {
      bubble.style.transform = 'translate(-50%, -10px) scale(1)';
      bubble.style.opacity = '1';
    }, 50);

    setTimeout(() => {
      bubble.style.transform = 'translate(-50%, -20px) scale(0.8)';
      bubble.style.opacity = '0';
      setTimeout(() => bubble.remove(), 250);
    }, 1300);
  }

  // Função que executa o Beep Beep de forma isolada
  function triggerBeepBeep() {
    if (isHunting || isJumping) return;
    isHunting = true; // Bloqueia outras interações
    
    const lizardEl = document.getElementById('lizard');
    if (!lizardEl) return;
    
    lizardEl.classList.add('runner-beeping');
    
    // Mostra o balão "BEEP! BEEP!"
    showSpeechBubble('BEEP! BEEP!');
    
    setTimeout(() => {
      lizardEl.classList.remove('runner-beeping');
      isHunting = false;
    }, 800);
  }

  // Loop de Beep Beep aleatório (executa de vez em quando)
  function startBeepBeepLoop() {
    setTimeout(() => {
      if (!isHunting && !isJumping && Math.random() < 0.65) {
        triggerBeepBeep();
      }
      startBeepBeepLoop();
    }, 12000 + Math.random() * 8000); // Executa a cada 12 a 20 segundos
  }

  // Inicializa o fluxo de ticks e loops de animação
  requestAnimationFrame(updateBugs);
  setInterval(createBug, 3400);
  createBug(); // Primeiro tick imediato
  
  // Inicia o ciclo autônomo de Beep Beep
  startBeepBeepLoop();
});
