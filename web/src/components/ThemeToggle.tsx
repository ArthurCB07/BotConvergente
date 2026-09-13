import { useEffect, useState } from 'react';

/**
 * Tema em tres estados: claro, escuro e sistema.
 *
 * "Sistema" nao marca nada na raiz e deixa a media query decidir. Escolha
 * explicita marca `data-theme`, que vence a media query nos dois sentidos.
 * A preferencia e local do navegador: nao vai para o backend nem para o banco.
 */

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'painel.tema';

export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Navegador anonimo ou armazenamento bloqueado: cai no padrao.
  }
  return 'system';
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

const OPTIONS: Array<{ value: Theme; label: string; title: string }> = [
  { value: 'light', label: 'Claro', title: 'Sempre claro' },
  { value: 'dark', label: 'Escuro', title: 'Sempre escuro' },
  { value: 'system', label: 'Sistema', title: 'Acompanha a preferencia do sistema' },
];

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Sem armazenamento a escolha vale so para esta sessao.
    }
  }, [theme]);

  return (
    <div className="stack-sm">
      <span className="eyebrow">Tema</span>
      <div className="seg" role="group" aria-label="Tema da interface">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            aria-pressed={theme === option.value}
            title={option.title}
            onClick={() => setTheme(option.value)}
            style={{ flex: 1, fontSize: 11, padding: '5px 4px' }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
