# playwright-runtime-guard

**Console & Network Guard** automático para Playwright.

Pare de aprovar testes E2E "verdes" que escondem `console.error`, exceções não tratadas (`pageerror`), respostas `5xx` em segundo plano ou requisições de rede falhadas. O `playwright-runtime-guard` se conecta automaticamente ao `BrowserContext` do Playwright (incluindo popups e abas extras) via fixture (`auto: true`) ou helper manual, falhando o teste com um relatório detalhado sempre que erros inesperados de runtime acontecerem.

## Recursos

- **Fixture automática sem boilerplate**: Substituição direta de `{ test, expect }` via `playwright-runtime-guard`, ou composição com suas fixtures existentes via `extendTestWithGuard(seuTest)`.
- **Quatro sinais de runtime monitorados**:
  - Erros de `console` (`consoleTypes` configurável, padrão `['error']`)
  - Exceções não tratadas (`pageerror`) e *unhandled promise rejections*
  - Respostas HTTP com erro (padrão `5xx`; configurável para `'4xx+'`, lista de status ou predicado), com captura opcional de trecho do corpo JSON/texto
  - Falhas de rede (`requestfailed`), ignorando automaticamente cancelamentos benignos de navegação (`net::ERR_ABORTED` / `NS_BINDING_ABORTED`), a menos que `includeAbortedRequests: true` seja definido
- **Deduplicação de ruído do navegador**: Suprime mensagens sintéticas do browser como `"Failed to load resource: the server responded with a status of ..."` para que status `404` (ex.: `/favicon.ico`) e regras de `ignoreHttpErrors` não vazem como `console.error` duplicados.
- **Allowlist granular**: Combine por substring, `RegExp`, objetos de regra (`url`, `status`, `method`, `resourceType`, `locationUrl`, `pageUrl`) ou funções predicado.
- **Exceções pontuais e com escopo**: Use `runtimeGuard.runAllowed(...)`, `runtimeGuard.allowOnce(...)` ou `runtimeGuard.allow(...)` em etapas do teste que provocam erros propositalmente.
- **Rastreamento de popups e múltiplas abas**: Monitora o `BrowserContext` inteiro e eventos `popup`, cobrindo novas abas e janelas abertas com `window.open()`.
- **Anexos no relatório HTML do Playwright**: Anexa automaticamente `runtime-guard-report.json` e `runtime-guard-report.md` quando houver violações.
- **Sem mascarar falhas anteriores**: Se o teste já tiver falhado por outro motivo (ex.: timeout de seletor ou assertion), o guard anexa e registra as violações no log sem sobrescrever o erro principal (configurável via `failOnAlreadyFailedTest: true`).

## Instalação

```bash
npm install -D playwright-runtime-guard
```

> Dependência peer: `@playwright/test >= 1.40.0`

## Como usar

### 1. Uso direto com a fixture (`test` & `expect`)

```ts
import { test, expect } from 'playwright-runtime-guard';

test('página de checkout carrega sem erros', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
  // Falha automaticamente no teardown se ocorrer console.error, pageerror, 5xx ou requestfailed!
});
```

### 2. Configuração padrão do projeto (`createGuardTest` ou `extendTestWithGuard`)

Crie um arquivo compartilhado `fixtures.ts` na sua suíte de testes:

```ts
// tests/fixtures.ts
import { test as base } from '@playwright/test';
import { extendTestWithGuard } from 'playwright-runtime-guard';

const baseComUsuario = base.extend<{ usuarioLogado: string }>({
  usuarioLogado: async ({}, use) => {
    await use('alice@example.com');
  },
});

export const test = extendTestWithGuard(baseComUsuario, {
  failOnHttpStatus: '4xx+',
  ignoreHttpErrors: [
    { url: '/favicon.ico', status: 404 },
    { url: /\/api\/feature-flags/, status: [404, 503] },
  ],
  ignoreConsole: [
    'ResizeObserver loop completed with undelivered notifications',
    /Download the React DevTools/,
  ],
});

export { expect } from '@playwright/test';
```

### 3. Sobrescrita por arquivo ou bloco `describe` (`test.use`)

Listas de exceções passadas via `test.use({ guardOptions })` são mescladas de forma **aditiva** com os padrões globais, enquanto opções escalares (`mode`, `failOnHttpStatus`, etc.) sobrescrevem os padrões:

```ts
import { test, expect } from './fixtures';

test.describe('página legada de faturamento', () => {
  test.use({
    guardOptions: {
      ignoreConsole: ['Legacy chart deprecation warning'],
      ignoreHttpErrors: [{ url: '/api/legacy-metrics', status: 500 }],
    },
  });

  test('exibe resumo de faturas', async ({ page }) => {
    await page.goto('/billing');
    await expect(page.getByText('Faturas')).toBeVisible();
  });
});
```

### 4. Exceções temporárias ou únicas dentro de um teste

Quando uma etapa do teste precisa provocar um erro esperado (ex.: validar cupom inválido ou testar *retry* após `503`):

```ts
test('exibe erro ao aplicar cupom inválido', async ({ page, runtimeGuard }) => {
  await page.goto('/cart');

  await runtimeGuard.runAllowed(
    {
      ignoreHttpErrors: [{ url: '/api/coupon', status: 422, method: 'POST' }],
      ignoreConsole: ['Coupon validation failed'],
    },
    async () => {
      await page.fill('#coupon', 'INVALIDO');
      await page.click('#apply-coupon');
      await expect(page.getByText('Cupom inválido')).toBeVisible();
    },
  );
});

test('tenta novamente após um único 503', async ({ page, runtimeGuard }) => {
  // Consome no máximo UMA resposta 503 em /api/orders; uma segunda 503 ainda falha o teste.
  runtimeGuard.allowOnce({
    ignoreHttpErrors: [{ url: '/api/orders', status: 503 }],
  });

  await page.goto('/orders');
});
```

### 5. Uso manual (sem fixture)

```ts
import { test } from '@playwright/test';
import { attachRuntimeGuard } from 'playwright-runtime-guard';

test('guard manual', async ({ page }) => {
  const guard = attachRuntimeGuard(page, {
    failOnHttpStatus: '5xx',
  });

  await page.goto('/dashboard');
  await guard.assertClean();
  guard.dispose();
});
```

## Opções de configuração

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `mode` | `'fail'` (ou `PW_GUARD_MODE`) | `'fail'` lança `RuntimeGuardError`, `'warn'` apenas registra aviso e anotação, `'off'` desativa o guard. |
| `failOnConsoleError` | `true` | Captura e falha em mensagens de console correspondentes. |
| `consoleTypes` | `['error']` | Tipos de mensagem de console monitorados (ex.: `['error', 'warning']`). |
| `dedupeBrowserResourceConsoleErrors` | `true` | Suprime logs sintéticos `"Failed to load resource: ..."` para evitar duplicatas e respeitar `failOnHttpStatus` / `ignoreHttpErrors`. |
| `failOnPageError` | `true` | Captura exceções não tratadas e *unhandled promise rejections*. |
| `failOnHttpStatus` | `'5xx'` | `'5xx'` / `true`, `'4xx+'`, `number[]`, `(status, ctx) => boolean` ou `false`. |
| `failOnRequestFailed` | `true` | Captura falhas na camada de rede (`net::ERR_CONNECTION_REFUSED`, etc.). |
| `includeAbortedRequests` | `false` | Inclui requisições abortadas por navegação (`net::ERR_ABORTED` / `NS_BINDING_ABORTED`). |
| `captureResponseBody` | `true` | Captura até 500 caracteres do corpo JSON/texto de respostas HTTP com erro. |
| `trackPopups` | `true` | Monitora automaticamente popups (`window.open`) e páginas extras do contexto. |
| `attachReport` | `'on-violation'` | Anexa `runtime-guard-report.json` e `.md` (`'on-violation' \| 'always' \| 'never'`). |
| `failOnAlreadyFailedTest` | `false` | Se `false`, anexa/loga as violações sem esconder uma falha prévia de assertion ou timeout. |
| `ignoreConsole` | `[]` | Regras de allowlist para mensagens de console. |
| `ignorePageErrors` | `[]` | Regras de allowlist para exceções `pageerror`. |
| `ignoreHttpErrors` | `[]` | Regras de allowlist para respostas HTTP com erro. |
| `ignoreRequestFailed` | `[]` | Regras de allowlist para falhas de requisição de rede. |
| `onViolation` | `undefined` | Callback executado a cada violação não ignorada. |

## Exemplo de saída em caso de falha

Quando uma violação ocorre durante o teste, o `playwright-runtime-guard` falha o teste com um resumo agrupado e anexa `runtime-guard-report.json` e `runtime-guard-report.md` ao Playwright HTML Report:

```text
Error: [runtime-guard] Detected 2 runtime violation(s) (console: 1, pageerror: 0, http: 1, requestfailed: 0, ignored: 1)

Console Errors (1):
  - [error] Broken widget state (http://127.0.0.1:41203/app.js:18:9)
    page: http://127.0.0.1:41203/checkout

HTTP Error Responses (1):
  - 500 Internal Server Error POST http://127.0.0.1:41203/api/orders [fetch]
    page: http://127.0.0.1:41203/checkout
    body: {"error":"upstream timeout"}
```

## Variável de ambiente

Altere o modo de execução em toda a suíte sem editar código:

```bash
PW_GUARD_MODE=warn npx playwright test
PW_GUARD_MODE=off npx playwright test
```

## Desenvolvimento

```bash
npm install
npm test
```

## Licença

MIT
