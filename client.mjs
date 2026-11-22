const labels = {
  en: ["Native login", 'Run this command in a terminal on the Studio host to sign in for global mode.', 'Install Cline CLI in Agent management first.'],
  zh: ["原生登录", '在 Studio 主机的终端运行此命令，登录后即可使用全局模式。', '请先在 Agent 管理中安装 Cline CLI。'],
  'zh-tw': ["原生登入", '在 Studio 主機的終端機執行此命令，登入後即可使用全域模式。', '請先在 Agent 管理中安裝 Cline CLI。'],
  ja: ["ネイティブログイン", 'Studio ホストのターミナルでこのコマンドを実行し、global モード用にログインしてください。', '先にエージェント管理で Cline CLI をインストールしてください。'],
  ko: ["네이티브 로그인", 'Studio 호스트의 터미널에서 이 명령을 실행해 전역 모드에 로그인하세요.', 'Agent 관리에서 Cline CLI를 먼저 설치하세요.'],
  fr: ["Connexion native", 'Exécutez cette commande dans le terminal de l’hôte Studio pour vous connecter en mode global.', 'Installez d’abord Cline CLI dans la gestion des agents.'],
  es: ["Inicio de sesión nativo", 'Ejecuta este comando en el terminal del host de Studio para iniciar sesión en el modo global.', 'Primero instala Cline CLI desde la gestión de agentes.'],
  de: ["Native Anmeldung", 'Führe diesen Befehl im Terminal des Studio-Hosts aus, um dich für den globalen Modus anzumelden.', 'Installiere zuerst Cline CLI in der Agentenverwaltung.'],
  pt: ["Login nativo", 'Execute este comando no terminal do host do Studio para entrar no modo global.', 'Primeiro instale o Cline CLI no gerenciador de agentes.'],
  ru: ["Вход в CLI", 'Выполните эту команду в терминале на хосте Studio для входа в глобальном режиме.', 'Сначала установите Cline CLI в разделе управления агентами.'],
  ar: ["تسجيل الدخول من الطرفية", 'نفّذ هذا الأمر في طرفية مضيف Studio لتسجيل الدخول في الوضع العام.', 'ثبّت Cline CLI أولاً من إدارة الوكلاء.'],
  tr: ["Yerel oturum açma", 'Global modda oturum açmak için bu komutu Studio ana makinesinin terminalinde çalıştırın.', 'Önce Agent yönetiminden Cline CLI’ı yükleyin.'],
}

export async function mount(root, ctx) {
  const locale = String(ctx.locale ?? 'en').replaceAll('_', '-').toLowerCase()
  const [title, instructions, needsInstall] = labels[locale] ?? labels[locale.split('-')[0]] ?? labels.en
  const section = document.createElement('section')
  section.style.cssText = 'box-sizing:border-box;max-width:55rem;padding:1rem;color:var(--text-primary);font:var(--font-size-base,14px)/var(--line-height,1.6) var(--font-family,system-ui)'
  if (locale.split('-')[0] === 'ar') section.dir = 'rtl'
  const heading = document.createElement('h1')
  heading.textContent = title
  heading.style.cssText = 'font-size:1.15em;margin:0'
  const help = document.createElement('p')
  help.style.color = 'var(--text-secondary)'
  section.append(heading, help)
  root.append(section)

  try {
    const { command } = await ctx.rpc.call('native-login')
    if (ctx.signal.aborted) return
    help.textContent = command ? instructions : needsInstall
    if (command) {
      const input = document.createElement('textarea')
      input.value = command
      input.readOnly = true
      input.dir = 'ltr'
      input.rows = 2
      input.setAttribute('aria-label', title)
      input.style.cssText = 'box-sizing:border-box;width:100%;padding:.5rem;color:var(--text-primary);background:var(--theme-input-bg,var(--bg-input));border:1px solid var(--border-color);border-radius:var(--radius-component,6px);resize:vertical;font-family:ui-monospace,monospace'
      input.addEventListener('focus', () => input.select())
      section.append(input)
    }
  } catch (error) {
    if (!ctx.signal.aborted) { help.setAttribute('role', 'alert'); help.textContent = error.message }
  }
  return () => section.remove()
}
