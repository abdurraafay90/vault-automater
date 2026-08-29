'use client';

import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet, type OfflineSigner } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient, coin } from '@cosmjs/stargate';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

type KeplrProvider = {
  experimentalSuggestChain(config: object): Promise<void>;
  enable(chainId: string): Promise<void>;
  disable?(chainId: string): Promise<void>;
  getKey(chainId: string): Promise<{ bech32Address: string }>;
  getOfflineSigner?(chainId: string): OfflineSigner;
};
type BrowserWalletWindow = typeof window & { keplr?: KeplrProvider; getOfflineSignerAuto?(chainId: string): Promise<OfflineSigner>; getOfflineSigner?(chainId: string): OfflineSigner };
type Vault = { pair: string; name: string; address: string | null; accent: 'blue' | 'purple' | 'orange'; tvl: string; apy: string; type: string; risk: string; summary: string };
type AutomationStatus = 'stopped' | 'running' | 'paused';
type DeliveryMode = 'once' | 'automation';
type SessionSource = 'browser' | 'private';
type Automation = { mode: DeliveryMode; minimum: string; maximum: string; interval: number; customInterval: string; status: AutomationStatus; lastAt: number | null; nextAt: number | null };
type HistoryStatus = 'Pending' | 'Success' | 'Failed';
type HistoryEntry = { id: string; vaultIndex: number; time: number; amountBaseUnits: bigint; status: HistoryStatus; hash?: string; error?: string; source: 'Manual' | 'Automation' | 'Chain' };
type AuthUser = { id: string; email: string; role: 'ADMIN' | 'USER'; active: boolean; createdAt: string };
// Each vault tab owns its own signer, address, and balance — vaults are never forced to share one wallet.
type WalletSession = { mode: 'wallet' | 'private'; source: SessionSource | null; address: string; manualAddress: string; balanceBaseUnits: string; error: string; connecting: boolean; unlocking: boolean; hasSigner: boolean };

const chain = { chainId: 'zig-test-2', chainName: 'ZIGChain Testnet', rpc: 'https://testnet-rpc.zigchain.com', rest: 'https://testnet-api.zigchain.com' };
const defaultVaults: Vault[] = [
  { pair: 'PAIR 1', name: 'Stablecoin Yield', address: 'Not configured', accent: 'blue', tvl: '$39,717,012', apy: '9.95%', type: 'Stablecoin Yield', risk: 'Low', summary: 'Low-risk stablecoin strategy' },
  { pair: 'PAIR 2', name: 'Opportunistic Credit', address: 'Not configured', accent: 'purple', tvl: '$16,679,657', apy: '10.32%', type: 'Opportunistic', risk: 'Low', summary: 'Diversified private credit strategy' },
  { pair: 'PAIR 3', name: 'Core Income', address: 'Not configured', accent: 'orange', tvl: '$11,329,834', apy: '8.03%', type: 'Core Income', risk: 'Low', summary: 'Lower-volatility private credit strategy' },
];
const intervals = [
  { label: '30s', value: 30 }, { label: '60s', value: 60 }, { label: '5m', value: 300 },
  { label: '15m', value: 900 }, { label: '30m', value: 1800 }, { label: '60m', value: 3600 },
];
const API_URL = 'http://localhost:4000';
const GAS_MULTIPLIER = 1.5;

function apiRequest(path: string, init: RequestInit = {}) {
  return fetch(`${API_URL}${path}`, { ...init, credentials: 'include' });
}

function formatBaseUnits(value: string | bigint, decimals = 6) {
  const padded = value.toString().padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return `${BigInt(whole).toLocaleString()}${fraction ? `.${fraction}` : ''}`;
}

function parseZigAmount(value: string): bigint {
  const normalized = value.replaceAll(',', '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(normalized)) throw new Error('Enter a valid ZIG amount with no more than 6 decimals.');
  const [whole, fraction = ''] = normalized.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n) throw new Error('Transfer amount must be greater than zero.');
  return amount;
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) throw new Error('Use a 32-byte hex private key or a 12/24-word mnemonic.');
  return Uint8Array.from(normalized.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

function randomAmount(minimum: bigint, maximum: bigint) {
  if (minimum === maximum) return minimum;
  const random = new Uint32Array(2);
  crypto.getRandomValues(random);
  const value = (BigInt(random[0]) << 32n) | BigInt(random[1]);
  return minimum + (value % (maximum - minimum + 1n));
}

function formatCountdown(nextAt: number | null, now: number) {
  if (!nextAt) return '—';
  const seconds = Math.max(0, Math.ceil((nextAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function initialAutomations(): Automation[] {
  return defaultVaults.map(() => ({ mode: 'once', minimum: '', maximum: '', interval: 30, customInterval: '', status: 'stopped', lastAt: null, nextAt: null }));
}

function initialWalletSessions(): WalletSession[] {
  return defaultVaults.map(() => ({ mode: 'wallet', source: null, address: '', manualAddress: '', balanceBaseUnits: '0', error: '', connecting: false, unlocking: false, hasSigner: false }));
}

function unixNow() { return Date.now(); }

function hasValidRange(settings: Automation) {
  try {
    const minimum = parseZigAmount(settings.minimum);
    if (settings.mode === 'once') return minimum > 0n;
    const maximum = settings.maximum.trim() ? parseZigAmount(settings.maximum) : minimum;
    return maximum >= minimum && Number.isInteger(settings.interval) && settings.interval >= 5;
  } catch {
    return false;
  }
}

export default function Home() {
  const [vaults, setVaults] = useState<Vault[]>(defaultVaults);
  const [automations, setAutomations] = useState<Automation[]>(initialAutomations);
  const [selectedVault, setSelectedVault] = useState(0);
  const [walletSessions, setWalletSessions] = useState<WalletSession[]>(initialWalletSessions);
  const [historyFilter, setHistoryFilter] = useState('All');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sendingVaults, setSendingVaults] = useState<number[]>([]);
  const [transferStatus, setTransferStatus] = useState<{ kind: 'success' | 'error'; message: string; hash?: string } | null>(null);
  const [now, setNow] = useState(unixNow);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [companyUsers, setCompanyUsers] = useState<AuthUser[]>([]);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [adminMessage, setAdminMessage] = useState('');
  const [creatingUser, setCreatingUser] = useState(false);
  const [copiedHash, setCopiedHash] = useState('');

  const secretInputRef = useRef<HTMLInputElement>(null);
  const signersRef = useRef<Array<OfflineSigner | null>>([null, null, null]);
  const walletSessionsRef = useRef<WalletSession[]>(walletSessions);
  const vaultsRef = useRef<Vault[]>(defaultVaults);
  const automationsRef = useRef<Automation[]>(automations);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout> | null>>([null, null, null]);
  const transferQueueRef = useRef<Array<Promise<boolean>>>([Promise.resolve(true), Promise.resolve(true), Promise.resolve(true)]);
  const sessionGenerationRef = useRef<number[]>([0, 0, 0]);

  const vault = vaults[selectedVault];
  const automation = automations[selectedVault];
  const walletSession = walletSessions[selectedVault];
  const selectedHistory = useMemo(() => history.filter((entry) => entry.vaultIndex === selectedVault && (historyFilter === 'All' || entry.status === historyFilter)), [history, historyFilter, selectedVault]);
  const successfulHistory = history.filter((entry) => entry.vaultIndex === selectedVault && entry.status === 'Success');
  const totalTransferred = successfulHistory.reduce((sum, entry) => sum + entry.amountBaseUnits, 0n);
  const anyRunning = automations.some((item) => item.status === 'running');
  const anyActive = automations.some((item) => item.status !== 'stopped');

  useEffect(() => {
    void (async () => {
      try {
        const response = await apiRequest('/api/auth/me');
        if (!response.ok) return;
        const data = await response.json() as { user: AuthUser };
        setAuthUser(data.user);
        await loadPublicConfig();
      } catch {
        setAuthUser(null);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    const ticker = window.setInterval(() => setNow(unixNow()), 1000);
    return () => {
      window.clearInterval(ticker);
      timers.forEach((timer) => timer && clearTimeout(timer));
    };
  }, []);

  function patchAutomation(index: number, patch: Partial<Automation>) {
    const next = automationsRef.current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
    automationsRef.current = next;
    setAutomations(next);
  }

  function patchWalletSession(index: number, patch: Partial<WalletSession>) {
    const next = walletSessionsRef.current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
    walletSessionsRef.current = next;
    setWalletSessions(next);
  }

  function clearVaultTimer(index: number) {
    const timer = timersRef.current[index];
    if (timer) clearTimeout(timer);
    timersRef.current[index] = null;
  }

  async function loadPublicConfig() {
    const response = await apiRequest('/api/config/public');
    if (!response.ok) throw new Error('Configuration service unavailable.');
    const data = await response.json() as { vaults: Array<{ name: string; address: string | null }> };
    const configured = defaultVaults.map((item, index) => ({ ...item, name: data.vaults[index]?.name ?? item.name, address: data.vaults[index]?.address ?? null }));
    vaultsRef.current = configured;
    setVaults(configured);
  }

  async function loadBalance(index: number, address: string, generation = sessionGenerationRef.current[index]) {
    const response = await apiRequest(`/api/wallet/${encodeURIComponent(address)}/balance`);
    if (!response.ok) throw new Error('Wallet opened, but the ZIG balance could not be loaded.');
    const balance = await response.json() as { amountBaseUnits: string };
    if (generation === sessionGenerationRef.current[index]) patchWalletSession(index, { balanceBaseUnits: balance.amountBaseUnits });
  }

  async function loadHistory(index: number, address: string, generation = sessionGenerationRef.current[index]) {
    try {
      const response = await apiRequest(`/api/wallet/${encodeURIComponent(address)}/transactions?limit=50`);
      if (!response.ok) return;
      const data = await response.json() as { transactions: Array<{ hash: string; vaultIndex: number; timestamp: string | null; amountBaseUnits: string; status: 'Success' | 'Failed' }> };
      const chainHistory: HistoryEntry[] = data.transactions
        .filter((transaction) => transaction.vaultIndex >= 0 && /^\d+$/.test(transaction.amountBaseUnits))
        .map((transaction) => ({
          id: `chain-${transaction.hash}-${transaction.vaultIndex}`,
          vaultIndex: transaction.vaultIndex,
          time: transaction.timestamp ? Date.parse(transaction.timestamp) : 0,
          amountBaseUnits: BigInt(transaction.amountBaseUnits),
          status: transaction.status,
          hash: transaction.hash,
          source: 'Chain',
        }));
      if (generation !== sessionGenerationRef.current[index]) return;
      setHistory((current) => {
        const chainHashes = new Set(chainHistory.map((entry) => entry.hash));
        const localOnly = current.filter((entry) => !entry.hash || !chainHashes.has(entry.hash));
        return [...localOnly, ...chainHistory].sort((left, right) => right.time - left.time).slice(0, 100);
      });
    } catch {
      // Live session history remains available if chain history is temporarily unavailable.
    }
  }

  async function connectKeplr(index: number) {
    const generation = sessionGenerationRef.current[index];
    patchWalletSession(index, { connecting: true, error: '' });
    try {
      const browserWallet = window as BrowserWalletWindow;
      const keplr = browserWallet.keplr;
      if (!keplr) throw new Error('Install the Keplr browser extension to connect.');
      await keplr.experimentalSuggestChain({
        ...chain,
        bip44: { coinType: 118 },
        bech32Config: { bech32PrefixAccAddr: 'zig', bech32PrefixAccPub: 'zigpub', bech32PrefixValAddr: 'zigvaloper', bech32PrefixValPub: 'zigvaloperpub', bech32PrefixConsAddr: 'zigvalcons', bech32PrefixConsPub: 'zigvalconspub' },
        currencies: [{ coinDenom: 'ZIG', coinMinimalDenom: 'uzig', coinDecimals: 6 }],
        feeCurrencies: [{ coinDenom: 'ZIG', coinMinimalDenom: 'uzig', coinDecimals: 6, gasPriceStep: { low: 0.0025, average: 0.025, high: 0.05 } }],
        stakeCurrency: { coinDenom: 'ZIG', coinMinimalDenom: 'uzig', coinDecimals: 6 },
      });
      await keplr.enable(chain.chainId);
      const key = await keplr.getKey(chain.chainId);
      const signer = browserWallet.getOfflineSignerAuto
        ? await browserWallet.getOfflineSignerAuto(chain.chainId)
        : browserWallet.getOfflineSigner?.(chain.chainId) ?? keplr.getOfflineSigner?.(chain.chainId);
      if (!signer) throw new Error('Keplr connected, but its transaction signer is unavailable. Refresh the extension and try again.');
      const [signerAccount] = await signer.getAccounts();
      if (!signerAccount || signerAccount.address !== key.bech32Address) throw new Error('Keplr returned a signer for a different account.');
      await loadBalance(index, key.bech32Address, generation);
      if (generation !== sessionGenerationRef.current[index]) return;
      signersRef.current[index] = signer;
      patchWalletSession(index, { source: 'browser', address: key.bech32Address, hasSigner: true });
      void loadHistory(index, key.bech32Address, generation);
    } catch (error) {
      patchWalletSession(index, { error: error instanceof Error ? error.message : 'Wallet connection failed.' });
    } finally {
      patchWalletSession(index, { connecting: false });
    }
  }

  async function unlockManualSession(index: number) {
    const generation = sessionGenerationRef.current[index];
    patchWalletSession(index, { unlocking: true, error: '' });
    setTransferStatus(null);
    try {
      const secret = secretInputRef.current?.value.trim() ?? '';
      if (!secret) throw new Error('Enter a private key or mnemonic.');
      const signer = secret.includes(' ')
        ? await DirectSecp256k1HdWallet.fromMnemonic(secret, { prefix: 'zig' })
        : await DirectSecp256k1Wallet.fromKey(hexToBytes(secret), 'zig');
      const [account] = await signer.getAccounts();
      if (!account) throw new Error('No wallet account could be derived.');
      const expectedAddress = walletSessionsRef.current[index].manualAddress.trim();
      if (expectedAddress && expectedAddress !== account.address) throw new Error(`The secret belongs to ${account.address}, not the entered address.`);
      await loadBalance(index, account.address, generation);
      if (generation !== sessionGenerationRef.current[index]) return;
      signersRef.current[index] = signer;
      patchWalletSession(index, { source: 'private', address: account.address, manualAddress: account.address, hasSigner: true });
      void loadHistory(index, account.address, generation);
      if (secretInputRef.current) secretInputRef.current.value = '';
    } catch (error) {
      signersRef.current[index] = null;
      patchWalletSession(index, { hasSigner: false, error: error instanceof Error ? error.message : 'Could not unlock this wallet.' });
    } finally {
      patchWalletSession(index, { unlocking: false });
    }
  }

  function stopAutomation(index: number) {
    clearVaultTimer(index);
    patchAutomation(index, { status: 'stopped', nextAt: null });
  }

  function pauseAutomation(index: number) {
    clearVaultTimer(index);
    patchAutomation(index, { status: 'paused', nextAt: null });
  }

  function stopAll() {
    defaultVaults.forEach((_, index) => clearVaultTimer(index));
    const next = automationsRef.current.map((item) => ({ ...item, status: 'stopped' as const, nextAt: null }));
    automationsRef.current = next;
    setAutomations(next);
  }

  function pauseAll() {
    defaultVaults.forEach((_, index) => clearVaultTimer(index));
    const next = automationsRef.current.map((item) => item.status === 'running' ? { ...item, status: 'paused' as const, nextAt: null } : item);
    automationsRef.current = next;
    setAutomations(next);
  }

  function clearWalletSession(index: number) {
    stopAutomation(index);
    sessionGenerationRef.current[index] += 1;
    signersRef.current[index] = null;
    patchWalletSession(index, { source: null, address: '', manualAddress: '', balanceBaseUnits: '0', error: '', connecting: false, unlocking: false, hasSigner: false });
    setHistory((current) => current.filter((entry) => entry.vaultIndex !== index));
    setSendingVaults((current) => current.filter((item) => item !== index));
    if (selectedVault === index) setTransferStatus(null);
    if (secretInputRef.current) secretInputRef.current.value = '';
  }

  async function disconnectWallet(index: number) {
    const disconnectedSource = walletSessionsRef.current[index].source;
    clearWalletSession(index);
    if (disconnectedSource === 'browser') {
      // Keplr's enable/disable is global to the extension, not per-tab — only revoke it
      // once no other vault tab is still relying on a browser-wallet session.
      const stillUsingBrowser = walletSessionsRef.current.some((session, i) => i !== index && session.source === 'browser');
      if (!stillUsingBrowser) {
        try {
          const keplr = (window as typeof window & { keplr?: KeplrProvider }).keplr;
          await keplr?.disable?.(chain.chainId);
        } catch {
          // The local app session is cleared even when the extension does not expose permission revocation.
        }
      }
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginSubmitting(true);
    setLoginError('');
    try {
      const response = await apiRequest('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      if (!response.ok) throw new Error('Email or password is incorrect.');
      const data = await response.json() as { user: AuthUser };
      setAuthUser(data.user);
      setLoginPassword('');
      await loadPublicConfig();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Sign in failed.');
    } finally {
      setLoginSubmitting(false);
    }
  }

  async function handleLogout() {
    await Promise.all(defaultVaults.map((_, index) => disconnectWallet(index)));
    try { await apiRequest('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* Local state is still cleared. */ }
    const resetAutomations = initialAutomations();
    automationsRef.current = resetAutomations;
    setAutomations(resetAutomations);
    setAuthUser(null);
    setVaults(defaultVaults);
    vaultsRef.current = defaultVaults;
    setAdminOpen(false);
    setCompanyUsers([]);
    setLoginEmail('');
    setLoginPassword('');
  }

  async function openUserManagement() {
    setAdminOpen(true);
    setAdminMessage('');
    const response = await apiRequest('/api/admin/users');
    if (!response.ok) return setAdminMessage('User list could not be loaded.');
    const data = await response.json() as { users: AuthUser[] };
    setCompanyUsers(data.users);
  }

  async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatingUser(true);
    setAdminMessage('');
    try {
      const response = await apiRequest('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newUserEmail, password: newUserPassword }),
      });
      const data = await response.json() as { user?: AuthUser; message?: string; code?: string };
      if (!response.ok || !data.user) throw new Error(data.message ?? (data.code === 'EMAIL_ALREADY_EXISTS' ? 'That email already has an account.' : 'Account could not be created.'));
      setCompanyUsers((current) => [...current, data.user!]);
      setNewUserEmail('');
      setNewUserPassword('');
      setAdminMessage('Account created successfully.');
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Account could not be created.');
    } finally {
      setCreatingUser(false);
    }
  }

  async function copyTransactionHash(hash: string) {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHash(hash);
      window.setTimeout(() => setCopiedHash((current) => current === hash ? '' : current), 1600);
    } catch {
      setTransferStatus({ kind: 'error', message: 'Transaction hash could not be copied.' });
    }
  }

  function getAmountRange(index: number) {
    const settings = automationsRef.current[index];
    const minimum = parseZigAmount(settings.minimum);
    const maximum = settings.mode === 'once' ? minimum : settings.maximum.trim() ? parseZigAmount(settings.maximum) : minimum;
    if (maximum < minimum) throw new Error('Maximum amount must be greater than or equal to the minimum.');
    if (settings.mode === 'automation' && (!Number.isInteger(settings.interval) || settings.interval < 5)) throw new Error('Frequency must be at least 5 seconds.');
    return { minimum, maximum };
  }

  function canSend(index: number) {
    const target = vaults[index];
    const session = walletSessions[index];
    return Boolean(session?.hasSigner && target?.address && target.address !== 'Not configured' && hasValidRange(automations[index]));
  }

  function canAutomate(index: number) {
    return walletSessions[index]?.source === 'private' && canSend(index);
  }

  async function executeTransfer(index: number, amount: bigint, source: 'Manual' | 'Automation'): Promise<boolean> {
    const generation = sessionGenerationRef.current[index];
    const signer = signersRef.current[index];
    const target = vaultsRef.current[index];
    if (!signer || !target?.address || target.address === 'Not configured') {
      setTransferStatus({ kind: 'error', message: 'Unlock the signer and configure the vault address first.' });
      return false;
    }
    const startedAt = unixNow();
    const id = `${startedAt}-${index}-${crypto.randomUUID()}`;
    const entry: HistoryEntry = { id, vaultIndex: index, time: startedAt, amountBaseUnits: amount, status: 'Pending', source };
    setHistory((current) => [entry, ...current].slice(0, 100));
    setSendingVaults((current) => [...new Set([...current, index])]);
    let client: SigningStargateClient | null = null;
    try {
      const [account] = await signer.getAccounts();
      if (!account) throw new Error('Signer account is unavailable.');
      if (generation !== sessionGenerationRef.current[index]) return false;
      client = await SigningStargateClient.connectWithSigner(chain.rpc, signer, { gasPrice: GasPrice.fromString('0.025uzig') });
      if (generation !== sessionGenerationRef.current[index]) return false;
      const result = await client.sendTokens(account.address, target.address, [coin(amount.toString(), 'uzig')], GAS_MULTIPLIER, `Vaultflow ${source.toLowerCase()} · ${target.pair}`);
      if (result.code !== 0) throw new Error(result.rawLog || `Transaction failed with code ${result.code}.`);
      if (generation !== sessionGenerationRef.current[index]) return true;
      setHistory((current) => current.map((item) => item.id === id ? { ...item, status: 'Success', hash: result.transactionHash } : item));
      setTransferStatus({ kind: 'success', message: `${formatBaseUnits(amount)} ZIG sent to ${target.name}.`, hash: result.transactionHash });
      try { await loadBalance(index, account.address, generation); } catch { /* The confirmed transfer remains successful if balance refresh is temporarily unavailable. */ }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transfer failed.';
      if (generation === sessionGenerationRef.current[index]) {
        setHistory((current) => current.map((item) => item.id === id ? { ...item, status: 'Failed', error: message } : item));
        setTransferStatus({ kind: 'error', message });
      }
      return false;
    } finally {
      client?.disconnect();
      if (generation === sessionGenerationRef.current[index]) setSendingVaults((current) => current.filter((item) => item !== index));
    }
  }

  function enqueueTransfer(index: number, amount: bigint, source: 'Manual' | 'Automation') {
    const run = () => source === 'Automation' && automationsRef.current[index].status !== 'running' ? Promise.resolve(false) : executeTransfer(index, amount, source);
    const task = transferQueueRef.current[index].then(run, run);
    transferQueueRef.current[index] = task;
    return task;
  }

  async function runAutomationCycle(index: number) {
    if (automationsRef.current[index].status !== 'running') return;
    let amount: bigint;
    try {
      const range = getAmountRange(index);
      amount = randomAmount(range.minimum, range.maximum);
    } catch (error) {
      pauseAutomation(index);
      setTransferStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Invalid automation settings.' });
      return;
    }
    const success = await enqueueTransfer(index, amount, 'Automation');
    if (automationsRef.current[index].status !== 'running') return;
    if (!success) {
      pauseAutomation(index);
      setTransferStatus((current) => ({ kind: 'error', message: `${current?.message ?? 'Transfer failed.'} Automation paused to prevent repeated failures.` }));
      return;
    }
    const completedAt = unixNow();
    const nextAt = completedAt + automationsRef.current[index].interval * 1000;
    patchAutomation(index, { lastAt: completedAt, nextAt });
    clearVaultTimer(index);
    timersRef.current[index] = setTimeout(() => void runAutomationCycle(index), Math.max(0, nextAt - unixNow()));
  }

  function startAutomation(index: number) {
    try {
      if (automationsRef.current[index].mode !== 'automation') throw new Error('Select Automation mode first.');
      getAmountRange(index);
      if (!signersRef.current[index]) throw new Error('Unlock the private-key session first.');
      if (walletSessionsRef.current[index].source !== 'private') {
        throw new Error('Automation requires the Private Key session. Keplr requires approval for every transaction.');
      }
      const target = vaultsRef.current[index];
      if (!target?.address || target.address === 'Not configured') throw new Error('This vault address is not configured.');
      clearVaultTimer(index);
      patchAutomation(index, { status: 'running', nextAt: unixNow() });
      setTransferStatus(null);
      void runAutomationCycle(index);
    } catch (error) {
      setTransferStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Automation could not start.' });
    }
  }

  function startAll() {
    automationsRef.current.forEach((item, index) => {
      if (item.mode === 'automation' && canAutomate(index)) startAutomation(index);
    });
  }

  function sendManualTransfer() {
    setTransferStatus(null);
    try {
      const { minimum } = getAmountRange(selectedVault);
      void enqueueTransfer(selectedVault, minimum, 'Manual');
    } catch (error) {
      setTransferStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Transfer could not start.' });
    }
  }

  function updateSelectedAutomation(patch: Partial<Automation>) { patchAutomation(selectedVault, patch); }

  function selectDeliveryMode(mode: DeliveryMode) {
    if (automation.status !== 'stopped') stopAutomation(selectedVault);
    patchAutomation(selectedVault, { mode, status: 'stopped', nextAt: null });
    setTransferStatus(null);
  }

  function setCustomFrequency(value: string) {
    const seconds = Number(value);
    updateSelectedAutomation({ customInterval: value, ...(Number.isInteger(seconds) && seconds >= 5 ? { interval: seconds } : {}) });
  }

  const statusLabel = automation.status.toUpperCase();
  const automatedVaultIndexes = automations.map((item, index) => item.mode === 'automation' ? index : -1).filter((index) => index >= 0);
  const allReady = automatedVaultIndexes.length > 0 && automatedVaultIndexes.every((index) => canAutomate(index));
  const actionHint = !walletSession.source ? 'Connect a wallet to enable transfers.'
    : !walletSession.hasSigner ? 'The connected wallet does not expose a transaction signer.'
    : automation.mode === 'automation' && walletSession.source === 'browser' ? 'Keplr asks for approval on every transaction. Use the Private Key tab once to unlock automatic signing for this browser session.'
    : !vault.address || vault.address === 'Not configured' ? 'Configure this vault address first.'
    : !automation.minimum.trim() ? 'Enter an amount to enable the transfer button.'
    : !hasValidRange(automation) ? automation.mode === 'automation' ? 'Check the amount range and use a frequency of at least 5 seconds.' : 'Enter a valid ZIG amount.'
    : '';

  if (authLoading) return <main className="auth-shell"><div className="auth-loading"><span className="brand-glyph">V</span><p>Loading Vaultflow…</p></div></main>;

  if (!authUser) return (
    <main className="auth-shell">
      <section className="login-card">
        <div className="login-brand"><span className="brand-glyph">V</span><div><strong>Vaultflow</strong><small>Internal operations console</small></div></div>
        <div className="login-copy"><span>AUTHORIZED ACCESS</span><h1>Sign in to continue</h1><p>Use the company account provided by your administrator.</p></div>
        <form onSubmit={handleLogin}>
          <label><span>EMAIL ADDRESS</span><input type="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} autoComplete="username" placeholder="name@company.com" required /></label>
          <label><span>PASSWORD</span><input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} autoComplete="current-password" placeholder="Enter your password" required /></label>
          {loginError && <p className="login-error" role="alert">{loginError}</p>}
          <button type="submit" disabled={loginSubmitting}>{loginSubmitting ? 'SIGNING IN…' : 'SIGN IN'}</button>
        </form>
        <small className="login-footnote">Accounts are created by the company administrator.</small>
      </section>
    </main>
  );

  return (
    <main className="console-shell">
      <nav className="vault-nav" aria-label="Vault selection">
        <div className="nav-brand"><span className="brand-glyph">V</span><span>Vaultflow</span></div>
        <div className="pair-tabs" role="tablist">{vaults.map((item, index) => <button key={item.pair} className={`pair-tab ${selectedVault === index ? 'active' : ''}`} type="button" role="tab" aria-selected={selectedVault === index} onClick={() => setSelectedVault(index)}><span>{item.name}</span>{walletSessions[index].source && <span className="connected-mini" title="Wallet connected">●</span>}<span className={`pair-dot ${item.accent}`} /></button>)}</div>
        <div className="account-tools"><span className="account-identity"><b>{authUser.email.slice(0, 2).toUpperCase()}</b><span><strong>{authUser.email}</strong><small>{authUser.role}</small></span></span>{authUser.role === 'ADMIN' && <button type="button" onClick={() => void openUserManagement()}>USERS</button>}<button className="logout-button" type="button" onClick={() => void handleLogout()}>LOGOUT</button></div>
      </nav>

      {adminOpen && authUser.role === 'ADMIN' && <div className="admin-overlay" role="dialog" aria-modal="true" aria-label="Company user management"><section className="admin-panel"><header><div><span>ADMINISTRATION</span><h2>Company accounts</h2><p>Create login access for another team member.</p></div><button type="button" onClick={() => setAdminOpen(false)} aria-label="Close user management">×</button></header><form onSubmit={handleCreateUser}><label><span>EMAIL</span><input type="email" value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} placeholder="teammate@company.com" required /></label><label><span>TEMPORARY PASSWORD</span><input type="password" minLength={8} value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} placeholder="At least 8 characters" required /></label><button type="submit" disabled={creatingUser}>{creatingUser ? 'CREATING…' : 'CREATE ACCOUNT'}</button></form>{adminMessage && <p className="admin-message" role="status">{adminMessage}</p>}<div className="user-list"><div className="user-list-head"><span>ACCOUNT</span><span>ROLE</span><span>STATUS</span></div>{companyUsers.map((user) => <div className="user-list-row" key={user.id}><span><strong>{user.email}</strong><small>Created {new Date(user.createdAt).toLocaleDateString()}</small></span><b>{user.role}</b><i>{user.active ? 'ACTIVE' : 'DISABLED'}</i></div>)}</div></section></div>}

      <div className="console-content">
        <header className="vault-hero">
          <div className="hero-title"><p><span className={`pulse ${vault.accent}`} /> {vault.pair} — VAULT AUTOMATION CONSOLE</p><h1><span>ZIG</span><b>→</b>{vault.name}</h1></div>
          <div className="hero-status"><span className="state-pill"><i /> TIMER READY</span><span className={`state-pill ${automation.status}`}>{statusLabel}</span><button type="button" onClick={() => void disconnectWallet(selectedVault)} disabled={!walletSession.source}>DISCONNECT</button></div>
        </header>

        <section className="global-bar">
          <div><span className="global-icon">◎</span><span><strong>Global automation</strong><small>{allReady ? `${automatedVaultIndexes.length} automation schedule${automatedVaultIndexes.length === 1 ? '' : 's'} ready` : 'Choose Automation on at least one vault and complete its settings'}</small></span></div>
          <div className="global-buttons"><button type="button" onClick={startAll} disabled={!allReady}>START ALL</button><button type="button" onClick={pauseAll} disabled={!anyRunning}>PAUSE ALL</button><button className="stop" type="button" onClick={stopAll} disabled={!anyActive}>STOP ALL</button></div>
        </section>

        <section className="two-column">
          <article className="console-card wallet-card">
            <div className="card-title"><span className="title-icon blue">▣</span><div><h2>Wallet Access</h2><p>Each vault tab keeps its own wallet connection.</p></div></div>
            <div className="mode-switch" role="tablist" aria-label="Wallet mode"><button className={walletSession.mode === 'wallet' ? 'active' : ''} type="button" onClick={() => patchWalletSession(selectedVault, { mode: 'wallet' })}>BROWSER WALLET {walletSession.source === 'browser' && <span className="connected-mini">CONNECTED</span>}</button><button className={walletSession.mode === 'private' ? 'active' : ''} type="button" onClick={() => patchWalletSession(selectedVault, { mode: 'private' })}>PRIVATE KEY {walletSession.source === 'private' && <span className="connected-mini">CONNECTED</span>}</button></div>
            {walletSession.source ? (
              <div className="connection-panel">
                <div className="connection-heading"><span className="connection-mark">✓</span><div><small>ACTIVE CONNECTION · {vault.pair}</small><h3>{walletSession.source === 'browser' ? 'Browser wallet connected' : 'Private-key session connected'}</h3></div><span className="connection-method">{walletSession.source === 'browser' ? 'KEPLR' : 'PRIVATE KEY'}</span></div>
                <div className="connected-account"><span>WALLET ADDRESS</span><code>{walletSession.address}</code><span>BALANCE</span><strong>{formatBaseUnits(walletSession.balanceBaseUnits)} ZIG</strong></div>
                <p>This connection only applies to {vault.name}. Select another vault tab to connect a different wallet.</p>
                <button className="disconnect-button" type="button" onClick={() => void disconnectWallet(selectedVault)}>DISCONNECT & CLEAR WALLET DATA</button>
              </div>
            ) : walletSession.mode === 'wallet' ? (
              <div className="wallet-connect"><span className="wallet-orbit"><i /><b>◈</b></span><h3>Connect a browser wallet</h3><p>Connect Keplr to load the wallet address, balance, and confirmed vault transactions for {vault.name}.</p><button type="button" onClick={() => void connectKeplr(selectedVault)} disabled={walletSession.connecting}>{walletSession.connecting ? 'CONNECTING…' : 'CONNECT KEPLR'} <span>→</span></button><small>{walletSession.error || 'ZIGChain Testnet · chain ID zig-test-2'}</small></div>
            ) : (
              <div className="private-form"><label><span>WALLET ADDRESS (OPTIONAL VERIFICATION)</span><input value={walletSession.manualAddress} onChange={(event) => patchWalletSession(selectedVault, { manualAddress: event.target.value })} placeholder="zig1…" autoComplete="off" spellCheck={false} /></label><label><span>PRIVATE KEY / MNEMONIC</span><input ref={secretInputRef} type="password" placeholder="32-byte hex key or 12/24-word mnemonic" autoComplete="new-password" spellCheck={false} /></label><div className="warning-note"><b>!</b><p><strong>Browser-session automation only.</strong> The signer stays in memory and all loops stop when you disconnect, refresh, close, or suspend this tab.</p></div><button className="unlock-button" type="button" onClick={() => void unlockManualSession(selectedVault)} disabled={walletSession.unlocking}>{walletSession.unlocking ? 'UNLOCKING…' : 'UNLOCK SESSION'}</button>{walletSession.error && <p className="form-error" role="alert">{walletSession.error}</p>}</div>
            )}
          </article>

          <article className="console-card vault-card">
            <div className="card-title"><span className={`title-icon ${vault.accent}`}>◇</span><div><h2>Vault Details</h2><p>Server-controlled destination configuration.</p></div></div>
            <div className="vault-nameplate"><span className={`vault-badge ${vault.accent}`}>{vault.pair.replace('PAIR ', '0')}</span><div><small>SELECTED VAULT</small><strong>{vault.name}</strong></div><span className={vault.address && vault.address !== 'Not configured' ? 'configured' : 'not-configured'}>{vault.address && vault.address !== 'Not configured' ? 'READY' : 'NOT CONFIGURED'}</span></div>
            <p className="vault-summary">{vault.summary}</p>
            <div className="market-snapshot"><div><span>TVL</span><strong>{vault.tvl}</strong></div><div><span>Vault APY</span><strong>{vault.apy}</strong></div><div><span>Type</span><strong>{vault.type}</strong></div><div><span>Risk</span><strong>{vault.risk}</strong></div></div>
            <p className="snapshot-note">Reference snapshot supplied by the team · values are not live</p>
            <div className="detail-list"><div><span>Vault address</span><code>{vault.address}</code></div><div><span>Transfer token</span><strong>ZIG</strong></div><div><span>Source balance</span><strong>{walletSession.address ? `${formatBaseUnits(walletSession.balanceBaseUnits)} ZIG` : '—'}</strong></div><div><span>Native gas balance</span><strong>{walletSession.address ? `${formatBaseUnits(walletSession.balanceBaseUnits)} ZIG` : '—'}</strong></div><div><span>Total transferred</span><strong>{formatBaseUnits(totalTransferred)} ZIG</strong></div><div><span>Successful executions</span><strong>{successfulHistory.length}</strong></div></div>
            <div className="interface-banner"><span>⌁</span><div><strong>{vault.address && vault.address !== 'Not configured' ? 'DIRECT ZIG TRANSFER READY' : 'RECIPIENT_ADDRESS_NOT_CONFIGURED'}</strong><small>{vault.address && vault.address !== 'Not configured' ? 'Native ZIG transfers use a 1.5× simulated gas allowance.' : 'Add this vault wallet address to the server environment before transfers can run.'}</small></div></div>
          </article>
        </section>

        <section className="console-card strategy-card">
          <div className="card-title"><span className="title-icon orange">◷</span><div><h2>Strategy Configuration</h2><p>Independent settings for {vault.pair}.</p></div><span className="independent-pill">INDEPENDENT SCHEDULE</span></div>
          <div className="delivery-mode" aria-label="Transfer mode">
            <button className={automation.mode === 'once' ? 'active' : ''} type="button" disabled={automation.status === 'running'} onClick={() => selectDeliveryMode('once')}><strong>Send once</strong><small>One transfer using an exact amount</small></button>
            <button className={automation.mode === 'automation' ? 'active' : ''} type="button" disabled={automation.status === 'running'} onClick={() => selectDeliveryMode('automation')}><strong>Automation</strong><small>Repeat within an amount range</small></button>
          </div>
          <div className="direction-bar"><span className="active">SOURCE WALLET <b>→</b> {vault.name.toUpperCase()}</span><span>ZIG TRANSFER</span></div>
          <div className={`amount-grid ${automation.mode === 'once' ? 'single' : ''}`}><label><span>{automation.mode === 'once' ? 'AMOUNT TO SEND' : 'MINIMUM AMOUNT'}</span><div><input value={automation.minimum} onChange={(event) => updateSelectedAutomation({ minimum: event.target.value })} disabled={automation.status === 'running'} inputMode="decimal" placeholder="e.g. 0.1" /><b>ZIG</b></div></label><label className="max-field" aria-hidden={automation.mode === 'once'}><span>MAXIMUM AMOUNT</span><div><input value={automation.maximum} onChange={(event) => updateSelectedAutomation({ maximum: event.target.value })} disabled={automation.status === 'running' || automation.mode === 'once'} inputMode="decimal" placeholder="Blank uses minimum" tabIndex={automation.mode === 'once' ? -1 : 0} /><b>ZIG</b></div></label></div>
          <div className="amount-note"><b>Note:</b> {automation.mode === 'once' ? 'Send once transfers exactly the amount entered above.' : 'Each run chooses an amount between minimum and maximum. Failed transactions automatically pause this vault.'} ZIG uses 6 decimals.</div>
          {actionHint && <p className="action-hint">{actionHint}</p>}
          {transferStatus && <div className={`transfer-status ${transferStatus.kind}`} role="status"><strong>{transferStatus.kind === 'success' ? 'TRANSFER CONFIRMED' : 'TRANSFER NOT SENT'}</strong><span>{transferStatus.message}</span>{transferStatus.hash && <code>{transferStatus.hash}</code>}</div>}
          <div className={`automation-fields ${automation.mode === 'automation' ? 'expanded' : ''}`} aria-hidden={automation.mode !== 'automation'}><div><div className="frequency-row"><div><span>EXECUTION FREQUENCY</span><small>Choose a preset or set your own interval</small></div><div className="frequency-options">{intervals.map((item) => <button className={!automation.customInterval && automation.interval === item.value ? 'active' : ''} key={item.value} type="button" disabled={automation.status === 'running'} onClick={() => updateSelectedAutomation({ interval: item.value, customInterval: '' })}>{item.label}</button>)}<label className={automation.customInterval ? 'custom-frequency active' : 'custom-frequency'}><input type="number" min="5" step="1" value={automation.customInterval} disabled={automation.status === 'running' || automation.mode !== 'automation'} onChange={(event) => setCustomFrequency(event.target.value)} placeholder="Custom" tabIndex={automation.mode === 'automation' ? 0 : -1} /><span>sec</span></label></div></div></div></div>
          <div className="execution-strip"><div><span className={`execution-light ${automation.status}`} /><span><small>CURRENT STATUS</small><strong>{sendingVaults.includes(selectedVault) ? 'SENDING' : automation.mode === 'once' ? 'READY' : statusLabel}</strong></span></div><div><small>LAST EXECUTION</small><strong>{automation.lastAt ? new Date(automation.lastAt).toLocaleTimeString() : 'Never'}</strong></div><div><small>NEXT EXECUTION</small><strong>{automation.mode === 'once' ? 'Not scheduled' : automation.status === 'running' ? formatCountdown(automation.nextAt, now) : '—'}</strong></div><div className="strategy-actions">{automation.mode === 'once' ? <button className="manual-send primary-action" type="button" onClick={sendManualTransfer} disabled={!canSend(selectedVault) || sendingVaults.includes(selectedVault)}>SEND ONCE</button> : <><button type="button" onClick={() => pauseAutomation(selectedVault)} disabled={automation.status !== 'running'}>PAUSE</button><button className="danger" type="button" onClick={() => stopAutomation(selectedVault)} disabled={automation.status === 'stopped'}>STOP</button><button className="start" type="button" onClick={() => startAutomation(selectedVault)} disabled={!canAutomate(selectedVault) || automation.status === 'running'}>{automation.status === 'paused' ? 'RESUME' : 'START AUTOMATION'}</button></>}</div></div>
        </section>

        <section className="console-card history-card">
          <div className="history-header"><div className="card-title"><span className="title-icon purple">↗</span><div><h2>Transaction History</h2><p>{vault.pair} · {vault.name}</p></div></div><div className="history-filters">{['All','Success','Pending','Failed'].map((item) => <button className={historyFilter === item ? 'active' : ''} type="button" key={item} onClick={() => setHistoryFilter(item)}>{item}</button>)}</div></div>
          <div className="table-head"><span>TIME</span><span>AMOUNT</span><span>STATUS</span><span>TRANSACTION</span></div>
          {selectedHistory.length ? selectedHistory.map((entry) => <div className="history-row" key={entry.id} title={entry.error}><span>{new Date(entry.time).toLocaleTimeString()} <small>{entry.source}</small></span><strong>{formatBaseUnits(entry.amountBaseUnits)} ZIG</strong><span className={`history-status ${entry.status.toLowerCase()}`}>{entry.status}</span><div className="tx-cell"><code>{entry.hash ? `${entry.hash.slice(0, 10)}…${entry.hash.slice(-6)}` : entry.error ? entry.error.slice(0, 34) : 'Broadcasting…'}</code>{entry.hash && <button className={copiedHash === entry.hash ? 'copied' : ''} type="button" aria-label={copiedHash === entry.hash ? 'Transaction hash copied' : 'Copy transaction hash'} title={copiedHash === entry.hash ? 'Copied' : 'Copy transaction hash'} onClick={() => void copyTransactionHash(entry.hash!)}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg></button>}</div></div>) : <div className="history-empty"><span>↗</span><strong>No {historyFilter.toLowerCase()} transactions</strong><p>Transactions for this wallet and vault will appear here.</p></div>}
        </section>
      </div>
    </main>
  );
}
