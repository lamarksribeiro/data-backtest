/**
 * Mascote Interativo de Login - Data Runner (Versão Cibernética Geométrica Premium)
 * Encapsula de forma limpa e isolada todos os estilos, HTML e comportamentos do mascote.
 */

document.addEventListener('DOMContentLoaded', () => {
  const loginCard = document.querySelector('.login');
  if (!loginCard) return;

  // 1. Injetar Estilos CSS do Mascote e Ticks
  const style = document.createElement('style');
  style.textContent = `
    /* Estilos do Mascote Interativo (Papa-léguas Cibernético) */
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
      background: radial-gradient(1200px 600px at 50% -10%, rgba(249, 115, 22, 0.08), transparent 70%), var(--bg-0);
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

    /* Leve flutuação do Papa-léguas para dar sensação de vida */
    @keyframes runnerBreathing {
      0%, 100% {
        transform: translateY(0px) scaleY(1);
      }
      50% {
        transform: translateY(-2px) scaleY(0.98);
      }
    }
    
    #lizard {
      animation: runnerBreathing 4s ease-in-out infinite;
      transform-origin: 116px 115px;
    }

    /* Animação de Corrida / Dash Linear Ultra-Rápido (Estilo Quantum/Flicker) */
    @keyframes runnerDash {
      0% {
        transform: translateX(0px) skewX(0deg);
      }
      15% {
        /* Puxa para trás rapidamente (recuo de mola) */
        transform: translateX(-12px) skewX(-8deg);
      }
      35% {
        /* Avança instantaneamente (teleporte) */
        transform: translateX(110px) skewX(12deg);
      }
      65% {
        /* Retorna amortecido */
        transform: translateX(15px) skewX(-4deg);
      }
      100% {
        transform: translateX(0px) skewX(0deg);
      }
    }
    
    .runner-dashing {
      animation: runnerDash 0.5s cubic-bezier(0.22, 1, 0.36, 1) !important;
      animation-fill-mode: forwards;
    }

    /* Animação de Pulo / Esquiva Vertical (Desvio Técnico Limpo) */
    @keyframes runnerEvade {
      0% {
        transform: translateY(0px) scale(1);
        opacity: 1;
      }
      15% {
        transform: translateY(-24px) scaleY(1.05) skewX(-5deg);
        opacity: 0.9;
      }
      35% {
        transform: translateY(-28px) scaleY(1.05);
        opacity: 0.85;
      }
      70% {
        transform: translateY(2px) scaleY(0.98);
        opacity: 0.95;
      }
      100% {
        transform: translateY(0px) scale(1);
        opacity: 1;
      }
    }

    .runner-jumping {
      animation: runnerEvade 0.45s cubic-bezier(0.16, 1, 0.3, 1) !important;
      animation-fill-mode: forwards;
    }

    /* Animação do Beep Beep autônomo (flicker de carregamento) */
    @keyframes runnerBeep {
      0%, 100% { transform: scale(1); }
      30% { transform: scale(1.03) translateY(-1px); }
      60% { transform: scale(1.03) translateY(1px); }
    }

    .runner-beeping {
      animation: runnerBeep 0.6s ease-in-out !important;
      animation-fill-mode: forwards;
    }

    /* Rotação rápida do rastro de pernas em alta velocidade */
    @keyframes spinRastro {
      0% {
        transform: translateY(0px) scaleY(1);
        opacity: 0.6;
      }
      50% {
        transform: translateY(1px) scaleY(0.9);
        opacity: 0.95;
      }
      100% {
        transform: translateY(0px) scaleY(1);
        opacity: 0.6;
      }
    }

    /* Quando correndo ou pulando, oculta pernas estáticas e mostra o rastro de movimento linear */
    .runner-dashing #legs-static, .runner-jumping #legs-static {
      display: none !important;
    }
    .runner-dashing #legs-running, .runner-jumping #legs-running {
      display: block !important;
      animation: spinRastro 0.1s linear infinite !important;
    }

    /* Animação sutil da cauda de penas balançando */
    @keyframes tailWiggle {
      0%, 100% {
        transform: rotate(0deg);
      }
      50% {
        transform: rotate(-3deg);
      }
    }
    #lizard-tail {
      animation: tailWiggle 4s ease-in-out infinite;
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

  // 3. Criar e injetar o SVG do Papa-léguas Cibernético Geométrico (Data Runner)
  const mascotContainer = document.createElement('div');
  mascotContainer.className = 'mascot-container';
  mascotContainer.innerHTML = `
    <svg id="mascot" width="260" height="180" viewBox="0 0 260 180" style="overflow: visible;">
      <defs>
        <!-- Gradiente Metalizado Azul Profundo -->
        <linearGradient id="bodyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1e3a8a" />
          <stop offset="50%" stop-color="#1e40af" />
          <stop offset="100%" stop-color="#0f172a" />
        </linearGradient>

        <!-- Gradiente Neon Laranja Âmbar -->
        <linearGradient id="beakGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#f97316" />
          <stop offset="100%" stop-color="#ea580c" />
        </linearGradient>

        <!-- Gradiente Ciano Elétrico para o Visor -->
        <linearGradient id="visorGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#06b6d4" />
          <stop offset="100%" stop-color="#3b82f6" />
        </linearGradient>

        <!-- Filtro Glow para o Visor Neon -->
        <filter id="neonGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      <!-- Grupo do Papa-léguas Cibernético Geométrico (Data Runner) -->
      <g id="lizard" style="transform-origin: 116px 115px;">
        <!-- Cauda Aerodinâmica (3 penas estilizadas angulares como spoilers) -->
        <g id="lizard-tail">
          <!-- Pena Superior -->
          <polygon points="90,112 55,95 38,70 65,90" fill="#1e40af" opacity="0.85" />
          <!-- Pena do Meio -->
          <polygon points="90,116 48,108 30,90 58,104" fill="#2563eb" opacity="0.9" />
          <!-- Pena Inferior (Laranja) -->
          <polygon points="90,120 40,122 24,110 52,118" fill="url(#beakGrad)" opacity="0.95" />
        </g>

        <!-- Pernas Estáticas Metálicas (Design limpo de trem de pouso) -->
        <g id="legs-static">
          <!-- Perna Traseira -->
          <path d="M 106,128 L 98,158 L 88,162 M 98,158 L 108,162" fill="none" stroke="#475569" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
          <!-- Perna Dianteira -->
          <path d="M 120,128 L 114,158 L 104,162 M 114,158 L 124,162" fill="none" stroke="url(#beakGrad)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
        </g>

        <!-- Pernas Correndo / Rastro de Movimento Linear (Display none por padrão) -->
        <g id="legs-running" style="display: none; transform-origin: 116px 145px;">
          <!-- Linhas de rastro de alta velocidade (blur de corrida) -->
          <line x1="80" y1="140" x2="150" y2="140" stroke="#f97316" stroke-width="3" opacity="0.8" stroke-dasharray="15 8" />
          <line x1="90" y1="146" x2="135" y2="146" stroke="#ea580c" stroke-width="2.5" opacity="0.6" stroke-dasharray="8 6" />
          <line x1="75" y1="152" x2="145" y2="152" stroke="#06b6d4" stroke-width="2" opacity="0.75" stroke-dasharray="20 10" />
        </g>

        <!-- Corpo Geométrico/Aerodinâmico (Estilo Fuselagem de Caça) -->
        <polygon points="86,118 104,102 134,106 142,122 126,132 98,128" fill="url(#bodyGrad)" stroke="#1e40af" stroke-width="1" />
        <!-- Detalhe da fuselagem em Ciano -->
        <polygon points="106,108 126,110 134,120 120,124" fill="#06b6d4" opacity="0.2" />

        <!-- Asa Traseira Estilizada -->
        <polygon points="98,112 76,116 62,132 88,124 116,118" fill="#1e3a8a" stroke="#2563eb" stroke-width="0.8" />
        <polygon points="90,116 80,120 74,128 86,124" fill="url(#beakGrad)" opacity="0.85" />

        <!-- Pescoço Angular Fino -->
        <polygon points="118,104 136,52 142,54 126,106" fill="url(#bodyGrad)" />

        <!-- Cabeça Angular Aerodinâmica -->
        <polygon points="130,52 138,40 152,42 150,56 138,56" fill="url(#bodyGrad)" />

        <!-- Crista de Spoiler Geométrico -->
        <polygon points="134,42 114,30 102,18 122,32" fill="#1e40af" />
        <polygon points="136,41 122,26 112,14 128,29" fill="#06b6d4" />
        <polygon points="138,40 128,22 120,10 134,26" fill="url(#beakGrad)" />

        <!-- Olhos Normais e Espertos (Semi-perfil) -->
        <ellipse cx="137" cy="42" rx="4.5" ry="7.5" fill="#ffffff" stroke="#1e3a8a" stroke-width="1.2" />
        <ellipse cx="145.5" cy="41" rx="4.5" ry="7.5" fill="#ffffff" stroke="#1e3a8a" stroke-width="1.2" />

        <!-- pupilas para rastreamento ocular -->
        <g id="lizard-pupil" style="transition: transform 0.12s ease-out;">
          <!-- Pupila esquerda -->
          <ellipse cx="138.5" cy="42.5" rx="2" ry="3.2" fill="#000000" />
          <circle cx="137.9" cy="41.2" r="0.6" fill="#ffffff" />
          <!-- Pupila direita -->
          <ellipse cx="146.7" cy="41.5" rx="2" ry="3.2" fill="#000000" />
          <circle cx="146.1" cy="40.2" r="0.6" fill="#ffffff" />
        </g>

        <!-- Bico Angular Militar/Stealth -->
        <polygon points="144,48 168,48 164,54 142,54" fill="url(#beakGrad)" stroke="#c2410c" stroke-width="0.8" />
        <!-- Divisão do bico -->
        <line x1="144" y1="51" x2="164" y2="51" stroke="#7c2d12" stroke-width="1" />

        <!-- Elementos ocultos para manter compatibilidade retroativa -->
        <path id="lizard-tongue" d="M 140,48 Q 140,48 140,48" fill="none" opacity="0" display="none" />
        <circle id="lizard-tongue-tip" cx="140" cy="48" r="1" fill="none" opacity="0" display="none" />
      </g>
    </svg>
  `;
  wrapper.insertBefore(mascotContainer, loginCard);

  // 4. Lógica de Rastreamento do Visor e Comportamento das Partículas de Ticks
  const mascot = document.getElementById('mascot');
  const pupil = document.getElementById('lizard-pupil');
  
  let isHunting = false;
  let isJumping = false;
  let lastMouseMoveTime = Date.now();
  let idleEyeTimer = null;

  // Atualização do visor com base no mouse (coordenada central X=145, Y=47)
  function updatePupil(targetX, targetY) {
    if (!pupil || !mascot || isHunting || isJumping) return;
    
    const rect = mascot.getBoundingClientRect();
    const scaleX = rect.width / 260;
    const scaleY = rect.height / 180;
    
    const eyeCenterX = rect.left + 142.5 * scaleX;
    const eyeCenterY = rect.top + 41.5 * scaleY;
    
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

  // Loop de pulsação e leitura do visor quando inativo
  function startIdleEyes() {
    if (idleEyeTimer) return;
    
    idleEyeTimer = setInterval(() => {
      if (Date.now() - lastMouseMoveTime < 3000 || isHunting || isJumping) return;
      
      const angle = Math.random() * Math.PI * 2;
      const offset = Math.random() * 2.0;
      const px = Math.cos(angle) * offset;
      const py = Math.sin(angle) * offset;
      
      if (pupil) {
        pupil.style.transform = `translate(${px}px, ${py}px)`;
        
        // Piscada de olhos tradicional
        if (Math.random() < 0.22) {
          pupil.style.transform += ' scaleY(0.1)';
          setTimeout(() => {
            pupil.style.transform = pupil.style.transform.replace(' scaleY(0.1)', '');
          }, 150);
        }
      }
    }, 1000 + Math.random() * 1200);
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
      
      // Visor olha para o tick se estiver por perto
      if (!isHunting && !isJumping && pupil) {
        const rect = mascot.getBoundingClientRect();
        const scaleX = rect.width / 260;
        
        const mascotRect = mascot.getBoundingClientRect();
        const bugRect = bug.element.getBoundingClientRect();
        const bugLocalX = (bugRect.left - mascotRect.left) * scaleX;
        
        if (bugLocalX > 40 && bugLocalX < 200 && Math.random() < 0.15) {
          const dx = bugLocalX - 142.5;
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
    
    // 2. Colisão no pico do dash / impacto sobre a partícula (200ms)
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
      
    }, 200);
    
    // 3. Fim do dash (500ms) e reset
    setTimeout(() => {
      lizardEl.classList.remove('runner-dashing');
      isHunting = false;
      
      // Pequena chance de comemorar com log de status
      if (Math.random() < 0.25) {
        showSpeechBubble('GAIN!');
      }
    }, 500);
  }

  // Esquiva de Tick Ruim: Animação de Salto Vertical
  function triggerEvade(bugData) {
    if (isJumping || isHunting) return;
    isJumping = true;
    
    const lizardEl = document.getElementById('lizard');
    if (!lizardEl) return;
    
    // 1. Executa o Salto (CSS class)
    lizardEl.classList.add('runner-jumping');
    
    // 2. Feedback visual de desvio após atingir o pico (180ms)
    setTimeout(() => {
      createAvoidTag(bugData.x, bugData.y - 12);
    }, 180);
    
    // 3. Fim do pulo (450ms) e reset
    setTimeout(() => {
      lizardEl.classList.remove('runner-jumping');
      isJumping = false;
    }, 450);
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

  // Notificação HUD de Terminal (em vez de balão infantil de quadrinhos)
  function showSpeechBubble(text) {
    const oldBubble = mascotContainer.querySelector('.speech-bubble');
    if (oldBubble) oldBubble.remove();

    const bubble = document.createElement('div');
    bubble.className = 'speech-bubble';
    
    // Formatação de comando de terminal
    if (text === 'BEEP! BEEP!') {
      bubble.innerHTML = `<span style="color:#06b6d4;">❯</span> RUNNER_STATUS: <span style="color:#10b981; font-weight:800;">BEEP_BEEP</span>`;
    } else if (text === 'GAIN!') {
      bubble.innerHTML = `<span style="color:#f97316;">❯</span> BACKTEST_SIGNAL: <span style="color:#10b981; font-weight:800;">PROFIT_OK</span>`;
    } else {
      bubble.innerHTML = `<span style="color:#f97316;">❯</span> RUNNER_LOG: <span style="color:#cbd5e1;">${text}</span>`;
    }
    
    bubble.style.position = 'absolute';
    bubble.style.top = '-20px';
    bubble.style.left = '60%';
    bubble.style.transform = 'translate(-50%, -15px) scale(0.85)';
    bubble.style.opacity = '0';
    bubble.style.background = 'rgba(9, 13, 22, 0.96)';
    bubble.style.border = '1px solid rgba(6, 182, 212, 0.4)';
    bubble.style.color = '#cbd5e1';
    bubble.style.fontSize = '10.5px';
    bubble.style.fontFamily = 'var(--font-mono)';
    bubble.style.padding = '6px 12px';
    bubble.style.borderRadius = '6px';
    bubble.style.boxShadow = '0 0 20px rgba(6, 182, 212, 0.15), 0 8px 16px rgba(0, 0, 0, 0.6)';
    bubble.style.pointerEvents = 'none';
    bubble.style.whiteSpace = 'nowrap';
    bubble.style.zIndex = '20';
    bubble.style.transition = 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.18s';
    
    mascotContainer.appendChild(bubble);
    
    setTimeout(() => {
      bubble.style.transform = 'translate(-50%, -5px) scale(1)';
      bubble.style.opacity = '1';
    }, 50);

    setTimeout(() => {
      bubble.style.transform = 'translate(-50%, -15px) scale(0.85)';
      bubble.style.opacity = '0';
      setTimeout(() => bubble.remove(), 220);
    }, 1500);
  }

  // Função que executa o Beep Beep de forma isolada
  function triggerBeepBeep() {
    if (isHunting || isJumping) return;
    isHunting = true; // Bloqueia outras interações
    
    const lizardEl = document.getElementById('lizard');
    if (!lizardEl) return;
    
    lizardEl.classList.add('runner-beeping');
    
    // Mostra o console de log "BEEP! BEEP!"
    showSpeechBubble('BEEP! BEEP!');
    
    setTimeout(() => {
      lizardEl.classList.remove('runner-beeping');
      isHunting = false;
    }, 600);
  }

  // Loop de Beep Beep aleatório (executa de vez em quando)
  function startBeepBeepLoop() {
    setTimeout(() => {
      if (!isHunting && !isJumping && Math.random() < 0.65) {
        triggerBeepBeep();
      }
      startBeepBeepLoop();
    }, 14000 + Math.random() * 8000); // Executa a cada 14 a 22 segundos
  }

  // Inicializa o fluxo de ticks e loops de animação
  requestAnimationFrame(updateBugs);
  setInterval(createBug, 3400);
  createBug(); // Primeiro tick imediato
  
  // Inicia o ciclo autônomo de Beep Beep
  startBeepBeepLoop();
});
