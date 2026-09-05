'use client';

import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet, type EncodeObject, type OfflineSigner } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient, coin } from '@cosmjs/stargate';
import { ethers } from 'ethers';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

export type ChainType = 'zigchain' | 'erc';

export type Vault = {
  id?: string;
  pair: string;
  name: string;
  address: string | null;
  chainType: ChainType;
  accent: 'blue' | 'purple' | 'orange' | 'green' | 'cyan';
  tvl: string;
  apy: string;
  type: string;
  risk: string;
  summary: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
};

type ChainConfig = { name: string; id: string; rpcUrl: string; apiUrl: string; explorerUrl: string };
type EvmConfig = { rpcUrl: string; chainId: number; explorerUrl: string; nativeCurrency?: { name: string; symbol: string; decimals: number } };
type TokenConfig = { symbol: string; denom: string; decimals: number };
type IbcTransferConfig = {
  sourcePort: string;
  sourceChannel: string;
  timeoutSeconds: number;
  orbiter: {
    enabled: boolean;
    feeRecipient: string;
    feeAmount: string;
    destinationDomain: number;
    mintRecipient: string;
    destinationCaller: string;
    passthroughPayload: string;
  };
};

type AutomationStatus = 'stopped' | 'running' | 'paused';
type DeliveryMode = 'once' | 'automation';
type Automation = { mode: DeliveryMode; minimum: string; maximum: string; interval: number; customInterval: string; status: AutomationStatus; lastAt: number | null; nextAt: number | null };
type HistoryStatus = 'Pending' | 'Success' | 'Failed';
type HistoryEntry = { id: string; vaultIndex: number; time: number; amountBaseUnits: bigint; status: HistoryStatus; hash?: string; error?: string; source: 'Manual' | 'Automation' | 'Chain' };
type AuthUser = { id: string; email: string; role: 'ADMIN' | 'USER'; active: boolean; createdAt: string };
type WalletSession = { mode: 'private'; source: 'private' | null; address: string; manualAddress: string; balanceBaseUnits: string; nativeGasBaseUnits: string; error: string; connecting: boolean; unlocking: boolean; hasSigner: boolean };

type UniversalSigner =
  | { type: 'cosmos'; signer: OfflineSigner }
  | { type: 'evm'; wallet: ethers.Wallet; provider: ethers.JsonRpcProvider };

const defaultChainConfig: ChainConfig = {
  name: 'ZIGChain Testnet',
  id: 'zig-test-2',
  rpcUrl: 'https://testnet-rpc.zigchain.com',
  apiUrl: 'https://testnet-api.zigchain.com',
  explorerUrl: 'https://testnet.zigscan.org',
};

const defaultEvmConfig: EvmConfig = {
  rpcUrl: 'https://rpc.testnet.zigchain.com',
  chainId: 11155111,
  explorerUrl: 'https://testnet.zigscan.org',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
};

const defaultTokenConfig: TokenConfig = { symbol: 'ZIG', denom: 'uzig', decimals: 6 };

const defaultIbcTransferConfig: IbcTransferConfig = {
  sourcePort: 'transfer',
  sourceChannel: 'channel-3',
  timeoutSeconds: 600,
  orbiter: { enabled: false, feeRecipient: '', feeAmount: '', destinationDomain: 0, mintRecipient: '', destinationCaller: '', passthroughPayload: '' },
};

const defaultVaults: Vault[] = [
  { pair: 'PAIR 1', name: 'Stablecoin Yield', address: 'Not configured', chainType: 'zigchain', accent: 'blue', tvl: '$39,717,012', apy: '9.95%', type: 'Stablecoin Yield', risk: 'Low', summary: 'Low-risk stablecoin strategy on ZIGChain' },
  { pair: 'PAIR 2', name: 'Opportunistic Credit', address: 'Not configured', chainType: 'zigchain', accent: 'purple', tvl: '$16,679,657', apy: '10.32%', type: 'Opportunistic', risk: 'Low', summary: 'Diversified private credit strategy on ZIGChain' },
  { pair: 'PAIR 3', name: 'Core Income', address: 'Not configured', chainType: 'zigchain', accent: 'orange', tvl: '$11,329,834', apy: '8.03%', type: 'Core Income', risk: 'Low', summary: 'Lower-volatility private credit strategy on ZIGChain' },
  { pair: 'ERC 1', name: 'Nawa Finance', address: '0x6FE78B942C566fE2b8D0881cf3577C1B1511F204', chainType: 'erc', accent: 'green', tvl: '$24,850,000', apy: '12.40%', type: 'Shariah Ethical Yield', risk: 'Low', summary: 'Shariah-compliant ethical asset-backed yield vault', tokenSymbol: 'ETH', tokenDecimals: 18 },
  { pair: 'ERC 2', name: 'Valdora', address: '0x1754fCD1F0EBb306286dd16F00abCf46731a92FC', chainType: 'erc', accent: 'cyan', tvl: '$18,320,000', apy: '11.85%', type: 'Liquid Staking & Yield', risk: 'Medium', summary: 'Composable institutional liquid staking & yield vault', tokenSymbol: 'ETH', tokenDecimals: 18 },
];

const intervals = [
  { label: '30s', value: 30 }, { label: '60s', value: 60 }, { label: '5m', value: 300 },
  { label: '15m', value: 900 }, { label: '30m', value: 1800 }, { label: '60m', value: 3600 },
];

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const GAS_MULTIPLIER = 1.5;
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_TEN = BigInt(10);
const RANDOM_WORD_BITS = BigInt(32);
const MILLISECONDS_TO_NANOSECONDS = BigInt(1000000);

function apiRequest(path: string, init: RequestInit = {}) {
  return fetch(`${API_URL}${path}`, { ...init, credentials: 'include' });
}

function formatBaseUnits(value: string | bigint, decimals = 6) {
  const padded = value.toString().padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return `${BigInt(whole).toLocaleString()}${fraction ? `.${fraction}` : ''}`;
}

function baseUnitMultiplier(decimals: number) {
  return BIGINT_TEN ** BigInt(decimals);
}

function parseTokenAmount(value: string, decimals: number): bigint {
  const normalized = value.replaceAll(',', '').trim();
  const amountPattern = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!amountPattern.test(normalized)) throw new Error(`Enter a valid amount with no more than ${decimals} decimals.`);
  const [whole, fraction = ''] = normalized.split('.');
  const amount = BigInt(whole) * baseUnitMultiplier(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount <= BIGINT_ZERO) throw new Error('Transfer amount must be greater than zero.');
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
  const value = (BigInt(random[0]) << RANDOM_WORD_BITS) | BigInt(random[1]);
  return minimum + (value % (maximum - minimum + BIGINT_ONE));
}

function formatCountdown(nextAt: number | null, now: number) {
  if (!nextAt) return '—';
  const seconds = Math.max(0, Math.ceil((nextAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function createInitialAutomations(count: number): Automation[] {
  return Array.from({ length: count }, () => ({ mode: 'once', minimum: '', maximum: '', interval: 30, customInterval: '', status: 'stopped', lastAt: null, nextAt: null }));
}

function createInitialWalletSessions(count: number): WalletSession[] {
  return Array.from({ length: count }, () => ({ mode: 'private', source: null, address: '', manualAddress: '', balanceBaseUnits: '0', nativeGasBaseUnits: '0', error: '', connecting: false, unlocking: false, hasSigner: false }));
}

function unixNow() { return Date.now(); }

function hasValidRange(settings: Automation, decimals = defaultTokenConfig.decimals) {
  try {
    const minimum = parseTokenAmount(settings.minimum, decimals);
    if (settings.mode === 'once') return minimum > BIGINT_ZERO;
    const maximum = settings.maximum.trim() ? parseTokenAmount(settings.maximum, decimals) : minimum;
    return maximum >= minimum && Number.isInteger(settings.interval) && settings.interval >= 5;
  } catch {
    return false;
  }
}

export default function Home() {
  const [vaults, setVaults] = useState<Vault[]>(defaultVaults);
  const [chainConfig, setChainConfig] = useState<ChainConfig>(defaultChainConfig);
  const [evmConfig, setEvmConfig] = useState<EvmConfig>(defaultEvmConfig);
  const [transferToken, setTransferToken] = useState<TokenConfig>(defaultTokenConfig);
  const [nativeToken, setNativeToken] = useState<TokenConfig>(defaultTokenConfig);
  const [ibcTransfer, setIbcTransfer] = useState<IbcTransferConfig>(defaultIbcTransferConfig);
  const [automations, setAutomations] = useState<Automation[]>(() => createInitialAutomations(defaultVaults.length));
  const [selectedVault, setSelectedVault] = useState(0);
  const [walletSessions, setWalletSessions] = useState<WalletSession[]>(() => createInitialWalletSessions(defaultVaults.length));
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

  // Add Vault Modal & Sidebar State
  const [addVaultOpen, setAddVaultOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarFilter, setSidebarFilter] = useState<'all' | 'zigchain' | 'erc'>('all');
  const [newVaultName, setNewVaultName] = useState('');
  const [newVaultChain, setNewVaultChain] = useState<ChainType>('zigchain');
  const [newVaultAddress, setNewVaultAddress] = useState('');
  const [newVaultSummary, setNewVaultSummary] = useState('');
  const [newVaultSymbol, setNewVaultSymbol] = useState('');
  const [newVaultDecimals, setNewVaultDecimals] = useState('');
  const [addVaultError, setAddVaultError] = useState('');
  const [savingVault, setSavingVault] = useState(false);

  // Delete Vault Modal State
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [vaultToDelete, setVaultToDelete] = useState<{ index: number; vault: Vault } | null>(null);
  const [deletingVault, setDeletingVault] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const secretInputRef = useRef<HTMLInputElement>(null);
  const signersRef = useRef<Record<number, UniversalSigner | null>>({});
  const walletSessionsRef = useRef<WalletSession[]>(walletSessions);
  const vaultsRef = useRef<Vault[]>(defaultVaults);
  const chainConfigRef = useRef<ChainConfig>(defaultChainConfig);
  const evmConfigRef = useRef<EvmConfig>(defaultEvmConfig);
  const transferTokenRef = useRef<TokenConfig>(defaultTokenConfig);
  const nativeTokenRef = useRef<TokenConfig>(defaultTokenConfig);
  const ibcTransferRef = useRef<IbcTransferConfig>(defaultIbcTransferConfig);
  const automationsRef = useRef<Automation[]>(automations);
  const timersRef = useRef<Record<number, ReturnType<typeof setTimeout> | null>>({});
  const transferQueueRef = useRef<Record<number, Promise<boolean>>>({});
  const sessionGenerationRef = useRef<Record<number, number>>({});

  const vault = vaults[selectedVault] ?? vaults[0];
  const automation = automations[selectedVault] ?? { mode: 'once', minimum: '', maximum: '', interval: 30, customInterval: '', status: 'stopped', lastAt: null, nextAt: null };
  const walletSession = walletSessions[selectedVault] ?? { mode: 'private', source: null, address: '', manualAddress: '', balanceBaseUnits: '0', nativeGasBaseUnits: '0', error: '', connecting: false, unlocking: false, hasSigner: false };

  const currentTokenSymbol = vault?.tokenSymbol || (vault?.chainType === 'erc' ? 'ETH' : transferToken.symbol);
  const currentTokenDecimals = vault?.tokenDecimals ?? (vault?.chainType === 'erc' ? 18 : transferToken.decimals);

  const selectedHistory = useMemo(() => history.filter((entry) => entry.vaultIndex === selectedVault && (historyFilter === 'All' || entry.status === historyFilter)), [history, historyFilter, selectedVault]);
  const successfulHistory = history.filter((entry) => entry.vaultIndex === selectedVault && entry.status === 'Success');
  const totalTransferred = successfulHistory.reduce((sum, entry) => sum + entry.amountBaseUnits, BIGINT_ZERO);
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
      Object.values(timers).forEach((timer) => timer && clearTimeout(timer));
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (deleteModalOpen) {
          setDeleteModalOpen(false);
          setVaultToDelete(null);
        } else if (addVaultOpen) {
          setAddVaultOpen(false);
        } else if (sidebarOpen) {
          setSidebarOpen(false);
        } else if (adminOpen) {
          setAdminOpen(false);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [addVaultOpen, sidebarOpen, adminOpen, deleteModalOpen]);

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
    try {
      const response = await apiRequest('/api/config/public');
      if (!response.ok) throw new Error('Configuration service unavailable.');
      const data = await response.json() as {
        chain?: ChainConfig;
        evm?: EvmConfig;
        nativeToken?: TokenConfig;
        token?: TokenConfig;
        ibcTransfer?: IbcTransferConfig;
        vaults: Array<{ name: string; address: string | null; chainType?: ChainType }>;
      };

      const nextChainConfig = data.chain ?? defaultChainConfig;
      const nextEvmConfig = data.evm ?? defaultEvmConfig;
      const nextTransferToken = data.token ?? defaultTokenConfig;
      const nextNativeToken = data.nativeToken ?? defaultTokenConfig;
      const nextIbcTransfer = data.ibcTransfer ?? defaultIbcTransferConfig;

      // Base vaults updated with backend configuration
      const baseVaults: Vault[] = defaultVaults.map((item, index) => ({
        ...item,
        name: data.vaults?.[index]?.name ?? item.name,
        address: data.vaults?.[index]?.address ?? item.address,
        chainType: (data.vaults?.[index]?.chainType ?? item.chainType) as ChainType,
      }));

      // Load custom vaults from backend and local storage
      let customVaults: Vault[] = [];
      try {
        const customRes = await apiRequest('/api/vaults/custom');
        if (customRes.ok) {
          const customData = await customRes.json() as { vaults: Array<{ id: string; name: string; address: string; chainType: ChainType; tokenSymbol?: string; tokenDecimals?: number; summary?: string }> };
          customVaults = customData.vaults.map((cv, i) => ({
            id: cv.id,
            pair: cv.chainType === 'erc' ? `ERC ${i + 3}` : `CUSTOM ${i + 1}`,
            name: cv.name,
            address: cv.address,
            chainType: cv.chainType,
            accent: cv.chainType === 'erc' ? 'cyan' : 'blue',
            tvl: '$0',
            apy: '—',
            type: 'Custom Vault',
            risk: 'Medium',
            summary: cv.summary || 'Custom user vault',
            tokenSymbol: cv.tokenSymbol,
            tokenDecimals: cv.tokenDecimals,
          }));
        }
      } catch {}

      // Fallback/merge from localStorage
      try {
        const localCustom = JSON.parse(localStorage.getItem('vaultflow_custom_vaults') || '[]') as Vault[];
        localCustom.forEach((lv) => {
          if (!customVaults.some((cv) => cv.address === lv.address || cv.id === lv.id)) {
            customVaults.push(lv);
          }
        });
      } catch {}

      // Retrieve deleted vaults blacklist from localStorage
      let deletedVaultIds: string[] = [];
      try {
        deletedVaultIds = JSON.parse(localStorage.getItem('vaultflow_deleted_vaults') || '[]') as string[];
      } catch {}

      const allVaultsRaw = [...baseVaults, ...customVaults];
      const allVaultsFiltered = allVaultsRaw.filter((v) => !deletedVaultIds.includes(v.id));
      const allVaults = allVaultsFiltered.length > 0 ? allVaultsFiltered : baseVaults;

      chainConfigRef.current = nextChainConfig;
      evmConfigRef.current = nextEvmConfig;
      transferTokenRef.current = nextTransferToken;
      nativeTokenRef.current = nextNativeToken;
      ibcTransferRef.current = nextIbcTransfer;
      vaultsRef.current = allVaults;

      setChainConfig(nextChainConfig);
      setEvmConfig(nextEvmConfig);
      setTransferToken(nextTransferToken);
      setNativeToken(nextNativeToken);
      setIbcTransfer(nextIbcTransfer);
      setVaults(allVaults);

      // Expand automations and sessions if more vaults loaded
      setAutomations((cur) => cur.length < allVaults.length ? [...cur, ...createInitialAutomations(allVaults.length - cur.length)] : cur);
      setWalletSessions((cur) => cur.length < allVaults.length ? [...cur, ...createInitialWalletSessions(allVaults.length - cur.length)] : cur);
    } catch {}
  }

  async function loadBalance(index: number, address: string, generation = sessionGenerationRef.current[index] ?? 0) {
    const currentVault = vaultsRef.current[index];
    if (!currentVault) return;

    if (currentVault.chainType === 'erc') {
      try {
        const provider = new ethers.JsonRpcProvider(evmConfigRef.current.rpcUrl);
        const balanceWei = await provider.getBalance(address);
        const baseUnits = balanceWei.toString();
        if (generation === (sessionGenerationRef.current[index] ?? 0)) {
          patchWalletSession(index, { balanceBaseUnits: baseUnits, nativeGasBaseUnits: baseUnits });
        }
      } catch {
        // Leave existing balance if EVM RPC is unreachable
      }
      return;
    }

    // Cosmos / ZIGChain
    try {
      const transferDenom = transferTokenRef.current.denom;
      const gasDenom = nativeTokenRef.current.denom;
      const [transferResponse, gasResponse] = await Promise.all([
        apiRequest(`/api/wallet/${encodeURIComponent(address)}/balance?denom=${encodeURIComponent(transferDenom)}`),
        transferDenom === gasDenom
          ? Promise.resolve(null)
          : apiRequest(`/api/wallet/${encodeURIComponent(address)}/balance?denom=${encodeURIComponent(gasDenom)}`),
      ]);
      if (!transferResponse.ok || (gasResponse && !gasResponse.ok)) return;
      const transferBalance = await transferResponse.json() as { amountBaseUnits: string };
      const gasBalance = gasResponse ? await gasResponse.json() as { amountBaseUnits: string } : transferBalance;
      if (generation === (sessionGenerationRef.current[index] ?? 0)) {
        patchWalletSession(index, { balanceBaseUnits: transferBalance.amountBaseUnits, nativeGasBaseUnits: gasBalance.amountBaseUnits });
      }
    } catch {}
  }

  async function loadHistory(index: number, address: string, generation = sessionGenerationRef.current[index] ?? 0) {
    const currentVault = vaultsRef.current[index];
    if (currentVault?.chainType === 'erc') {
      // EVM history is recorded locally from transactions
      return;
    }
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
      if (generation !== (sessionGenerationRef.current[index] ?? 0)) return;
      setHistory((current) => {
        const chainHashes = new Set(chainHistory.map((entry) => entry.hash));
        const localOnly = current.filter((entry) => !entry.hash || !chainHashes.has(entry.hash));
        return [...localOnly, ...chainHistory].sort((left, right) => right.time - left.time).slice(0, 100);
      });
    } catch {}
  }

  async function unlockManualSession(index: number) {
    const generation = (sessionGenerationRef.current[index] ?? 0) + 1;
    sessionGenerationRef.current[index] = generation;
    patchWalletSession(index, { unlocking: true, error: '' });
    setTransferStatus(null);
    try {
      const secret = secretInputRef.current?.value.trim() ?? '';
      if (!secret) throw new Error('Enter a private key or mnemonic.');
      const currentVault = vaultsRef.current[index];
      if (!currentVault) throw new Error('Vault not selected.');

      if (currentVault.chainType === 'erc') {
        const provider = new ethers.JsonRpcProvider(evmConfigRef.current.rpcUrl);
        let wallet: ethers.Wallet;
        if (secret.includes(' ')) {
          const hd = ethers.HDNodeWallet.fromPhrase(secret);
          wallet = new ethers.Wallet(hd.privateKey, provider);
        } else {
          const cleanHex = secret.startsWith('0x') ? secret : `0x${secret}`;
          if (!/^0x[0-9a-fA-F]{64}$/.test(cleanHex)) {
            throw new Error('Use a 32-byte (64 hex characters) private key or 12/24-word mnemonic.');
          }
          wallet = new ethers.Wallet(cleanHex, provider);
        }
        const derivedAddress = wallet.address;
        const expectedAddress = walletSessionsRef.current[index]?.manualAddress.trim();
        if (expectedAddress && expectedAddress.toLowerCase() !== derivedAddress.toLowerCase()) {
          throw new Error(`The key belongs to ${derivedAddress}, not the entered address.`);
        }
        signersRef.current[index] = { type: 'evm', wallet, provider };
        patchWalletSession(index, { source: 'private', address: derivedAddress, manualAddress: derivedAddress, hasSigner: true });
        await loadBalance(index, derivedAddress, generation);
      } else {
        const signer = secret.includes(' ')
          ? await DirectSecp256k1HdWallet.fromMnemonic(secret, { prefix: 'zig' })
          : await DirectSecp256k1Wallet.fromKey(hexToBytes(secret), 'zig');
        const [account] = await signer.getAccounts();
        if (!account) throw new Error('No wallet account could be derived.');
        const expectedAddress = walletSessionsRef.current[index]?.manualAddress.trim();
        if (expectedAddress && expectedAddress !== account.address) {
          throw new Error(`The key belongs to ${account.address}, not the entered address.`);
        }
        signersRef.current[index] = { type: 'cosmos', signer };
        patchWalletSession(index, { source: 'private', address: account.address, manualAddress: account.address, hasSigner: true });
        await loadBalance(index, account.address, generation);
        void loadHistory(index, account.address, generation);
      }

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
    vaults.forEach((_, index) => clearVaultTimer(index));
    const next = automationsRef.current.map((item) => ({ ...item, status: 'stopped' as const, nextAt: null }));
    automationsRef.current = next;
    setAutomations(next);
  }

  function pauseAll() {
    vaults.forEach((_, index) => clearVaultTimer(index));
    const next = automationsRef.current.map((item) => item.status === 'running' ? { ...item, status: 'paused' as const, nextAt: null } : item);
    automationsRef.current = next;
    setAutomations(next);
  }

  function clearWalletSession(index: number) {
    stopAutomation(index);
    sessionGenerationRef.current[index] = (sessionGenerationRef.current[index] ?? 0) + 1;
    signersRef.current[index] = null;
    patchWalletSession(index, { source: null, address: '', manualAddress: '', balanceBaseUnits: '0', nativeGasBaseUnits: '0', error: '', connecting: false, unlocking: false, hasSigner: false });
    setHistory((current) => current.filter((entry) => entry.vaultIndex !== index));
    setSendingVaults((current) => current.filter((item) => item !== index));
    if (selectedVault === index) setTransferStatus(null);
    if (secretInputRef.current) secretInputRef.current.value = '';
  }

  async function disconnectWallet(index: number) {
    clearWalletSession(index);
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
    await Promise.all(vaults.map((_, index) => disconnectWallet(index)));
    try { await apiRequest('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
    const resetAutomations = createInitialAutomations(defaultVaults.length);
    automationsRef.current = resetAutomations;
    setAutomations(resetAutomations);
    setAuthUser(null);
    setVaults(defaultVaults);
    vaultsRef.current = defaultVaults;
    chainConfigRef.current = defaultChainConfig;
    transferTokenRef.current = defaultTokenConfig;
    nativeTokenRef.current = defaultTokenConfig;
    ibcTransferRef.current = defaultIbcTransferConfig;
    setChainConfig(defaultChainConfig);
    setTransferToken(defaultTokenConfig);
    setNativeToken(defaultTokenConfig);
    setIbcTransfer(defaultIbcTransferConfig);
    setAdminOpen(false);
    setCompanyUsers([]);
    setAddVaultOpen(false);
    setSidebarOpen(false);
    setSidebarFilter('all');
    setHistory([]);
    setSelectedVault(0);
    setLoginEmail('');
    setLoginPassword('');
  }

  async function openUserManagement() {
    setAdminMessage('');
    try {
      const response = await apiRequest('/api/admin/users');
      if (!response.ok) throw new Error('Could not load company user directory.');
      const data = await response.json() as { users: AuthUser[] };
      setCompanyUsers(data.users);
      setAdminOpen(true);
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Could not load users.');
      setAdminOpen(true);
    }
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
      if (!response.ok) throw new Error(data.message || 'User creation failed.');
      if (data.user) setCompanyUsers((current) => [...current, data.user!]);
      setNewUserEmail('');
      setNewUserPassword('');
      setAdminMessage('Team account created successfully.');
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'User creation failed.');
    } finally {
      setCreatingUser(false);
    }
  }

  async function copyTransactionHash(hash: string) {
    await navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    window.setTimeout(() => setCopiedHash((current) => current === hash ? '' : current), 1800);
  }

  function getAmountRange(index: number) {
    const currentVault = vaults[index];
    const decimals = currentVault?.tokenDecimals ?? (currentVault?.chainType === 'erc' ? 18 : transferToken.decimals);
    const settings = automations[index];
    const minimum = parseTokenAmount(settings.minimum, decimals);
    const maximum = settings.mode === 'once' ? minimum : settings.maximum.trim() ? parseTokenAmount(settings.maximum, decimals) : minimum;
    if (maximum < minimum) throw new Error('Maximum amount must be greater than or equal to the minimum.');
    if (settings.mode === 'automation' && (!Number.isInteger(settings.interval) || settings.interval < 5)) throw new Error('Frequency must be at least 5 seconds.');
    return { minimum, maximum };
  }

  function canSend(index: number) {
    const target = vaults[index];
    const session = walletSessions[index];
    const decimals = target?.tokenDecimals ?? (target?.chainType === 'erc' ? 18 : transferToken.decimals);
    return Boolean(session?.hasSigner && target?.address && target.address !== 'Not configured' && hasValidRange(automations[index], decimals));
  }

  function canAutomate(index: number) {
    return walletSessions[index]?.source === 'private' && canSend(index);
  }

  function buildOrbiterMemo(settings: IbcTransferConfig['orbiter']) {
    if (!settings.enabled) return '';
    if (!settings.mintRecipient || !settings.destinationCaller) throw new Error('Orbiter CCTP memo is missing mint recipient or destination caller.');
    const preActions = settings.feeRecipient && settings.feeAmount ? [{
      id: 'ACTION_FEE',
      attributes: {
        '@type': '/noble.orbiter.controller.action.v2.FeeAttributes',
        fees_info: [{ recipient: settings.feeRecipient, amount: { value: settings.feeAmount } }],
      },
    }] : [];
    return JSON.stringify({
      orbiter: {
        pre_actions: preActions,
        forwarding: {
          protocol_id: 'PROTOCOL_CCTP',
          attributes: {
            '@type': '/noble.orbiter.controller.forwarding.v1.CCTPAttributes',
            destination_domain: settings.destinationDomain,
            mint_recipient: settings.mintRecipient,
            destination_caller: settings.destinationCaller,
          },
          passthrough_payload: settings.passthroughPayload,
        },
      },
    });
  }

  function buildIbcTransferMessage(sender: string, receiver: string, amount: bigint): EncodeObject {
    const settings = ibcTransferRef.current;
    if (!settings.sourcePort || !settings.sourceChannel) throw new Error('IBC source port and channel must be configured.');
    return {
      typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
      value: {
        sourcePort: settings.sourcePort,
        sourceChannel: settings.sourceChannel,
        token: { denom: transferTokenRef.current.denom, amount: amount.toString() },
        sender,
        receiver,
        timeoutHeight: { revisionNumber: BIGINT_ZERO, revisionHeight: BIGINT_ZERO },
        timeoutTimestamp: BigInt(unixNow() + (settings.timeoutSeconds * 1000)) * MILLISECONDS_TO_NANOSECONDS,
        memo: buildOrbiterMemo(settings.orbiter),
      },
    };
  }

  async function executeTransfer(index: number, amount: bigint, source: 'Manual' | 'Automation'): Promise<boolean> {
    const generation = sessionGenerationRef.current[index] ?? 0;
    const universalSigner = signersRef.current[index];
    const target = vaultsRef.current[index];
    if (!universalSigner || !target?.address || target.address === 'Not configured') {
      setTransferStatus({ kind: 'error', message: 'Unlock the private key signer and configure the vault address first.' });
      return false;
    }

    const startedAt = unixNow();
    const id = `${startedAt}-${index}-${crypto.randomUUID()}`;
    const entry: HistoryEntry = { id, vaultIndex: index, time: startedAt, amountBaseUnits: amount, status: 'Pending', source };
    setHistory((current) => [entry, ...current].slice(0, 100));
    setSendingVaults((current) => [...new Set([...current, index])]);

    try {
      if (target.chainType === 'erc') {
        if (universalSigner.type !== 'evm') throw new Error('Signer is not an EVM wallet.');
        const tx = await universalSigner.wallet.sendTransaction({
          to: target.address,
          value: amount,
        });
        const receipt = await tx.wait(1);
        if (!receipt || receipt.status === 0) throw new Error('EVM transaction was reverted by the network.');
        if (generation !== (sessionGenerationRef.current[index] ?? 0)) return true;

        setHistory((current) => current.map((item) => item.id === id ? { ...item, status: 'Success', hash: tx.hash } : item));
        setTransferStatus({
          kind: 'success',
          message: `${formatBaseUnits(amount, target.tokenDecimals ?? 18)} ${target.tokenSymbol ?? 'ETH'} transferred to ${target.name}.`,
          hash: tx.hash,
        });
        try { await loadBalance(index, universalSigner.wallet.address, generation); } catch {}
        return true;
      } else {
        if (universalSigner.type !== 'cosmos') throw new Error('Signer is not a Cosmos signer.');
        const signer = universalSigner.signer;
        const [account] = await signer.getAccounts();
        if (!account) throw new Error('Signer account is unavailable.');
        if (generation !== (sessionGenerationRef.current[index] ?? 0)) return false;

        const client = await SigningStargateClient.connectWithSigner(
          chainConfigRef.current.rpcUrl,
          signer,
          { gasPrice: GasPrice.fromString(`0.025${nativeTokenRef.current.denom}`) }
        );

        let txHash = '';
        // If target is a native ZIGChain address (starts with zig1), use standard Bank Send for 100% testnet reliability
        if (target.address.startsWith('zig1')) {
          const sendResult = await client.sendTokens(
            account.address,
            target.address,
            [coin(amount.toString(), transferTokenRef.current.denom)],
            GAS_MULTIPLIER
          );
          if (sendResult.code !== 0) throw new Error(sendResult.rawLog || `Transaction failed with code ${sendResult.code}.`);
          txHash = sendResult.transactionHash;
        } else {
          const ibcResult = await client.signAndBroadcast(
            account.address,
            [buildIbcTransferMessage(account.address, target.address, amount)],
            GAS_MULTIPLIER
          );
          if (ibcResult.code !== 0) throw new Error(ibcResult.rawLog || `Transaction failed with code ${ibcResult.code}.`);
          txHash = ibcResult.transactionHash;
        }

        if (generation !== (sessionGenerationRef.current[index] ?? 0)) return true;
        setHistory((current) => current.map((item) => item.id === id ? { ...item, status: 'Success', hash: txHash } : item));
        setTransferStatus({
          kind: 'success',
          message: `${formatBaseUnits(amount, transferTokenRef.current.decimals)} ${transferTokenRef.current.symbol} transferred to ${target.name}.`,
          hash: txHash,
        });
        try { await loadBalance(index, account.address, generation); } catch {}
        return true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transfer failed.';
      if (generation === (sessionGenerationRef.current[index] ?? 0)) {
        setHistory((current) => current.map((item) => item.id === id ? { ...item, status: 'Failed', error: message } : item));
        setTransferStatus({ kind: 'error', message });
      }
      return false;
    } finally {
      setSendingVaults((current) => current.filter((item) => item !== index));
    }
  }

  function enqueueTransfer(index: number, amount: bigint, source: 'Manual' | 'Automation') {
    const queue = transferQueueRef.current[index] ?? Promise.resolve(true);
    const nextExecution = queue.then(() => executeTransfer(index, amount, source), () => executeTransfer(index, amount, source));
    transferQueueRef.current[index] = nextExecution;
    return nextExecution;
  }

  function scheduleNextCycle(index: number) {
    clearVaultTimer(index);
    const target = automationsRef.current[index];
    if (target.status !== 'running' || target.mode !== 'automation') return;
    const intervalMs = target.interval * 1000;
    const nextAt = unixNow() + intervalMs;
    patchAutomation(index, { nextAt });
    timersRef.current[index] = setTimeout(() => void runAutomationCycle(index), intervalMs);
  }

  async function runAutomationCycle(index: number) {
    if (automationsRef.current[index]?.status !== 'running') return;
    try {
      const { minimum, maximum } = getAmountRange(index);
      const amount = randomAmount(minimum, maximum);
      const success = await enqueueTransfer(index, amount, 'Automation');
      if (!success) {
        pauseAutomation(index);
        return;
      }
      patchAutomation(index, { lastAt: unixNow() });
      scheduleNextCycle(index);
    } catch (error) {
      pauseAutomation(index);
      setTransferStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Automation cycle failed.' });
    }
  }

  function startAutomation(index: number) {
    try {
      if (automationsRef.current[index]?.mode !== 'automation') throw new Error('Select Automation mode first.');
      getAmountRange(index);
      if (!signersRef.current[index]) throw new Error('Unlock the private-key session first.');
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

  async function handleAddVault(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddVaultError('');
    const name = newVaultName.trim();
    const address = newVaultAddress.trim();
    if (!name) return setAddVaultError('Vault name is required.');
    if (!address) return setAddVaultError('Vault address is required.');

    if (newVaultChain === 'zigchain') {
      if (!/^zig1[0-9a-z]{38,62}$/.test(address)) {
        return setAddVaultError('Enter a valid ZIGChain Bech32 address (starts with zig1...).');
      }
    } else {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return setAddVaultError('Enter a valid ERC / EVM hexadecimal address (0x followed by 40 hex characters).');
      }
    }

    setSavingVault(true);
    try {
      const symbol = newVaultSymbol.trim() || (newVaultChain === 'erc' ? 'ETH' : 'ZIG');
      const decimals = newVaultDecimals.trim() ? Number(newVaultDecimals) : (newVaultChain === 'erc' ? 18 : 6);
      const summary = newVaultSummary.trim() || `${newVaultChain === 'erc' ? 'ERC / EVM' : 'ZIGChain'} custom automated vault strategy`;

      let createdId = `custom-${unixNow()}`;
      // Save to API (best effort)
      try {
        const createRes = await apiRequest('/api/vaults/custom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, address, chainType: newVaultChain, tokenSymbol: symbol, tokenDecimals: decimals, summary }),
        });
        if (createRes.ok) {
          const createData = await createRes.json() as { vault?: { id: string } };
          if (createData.vault?.id) createdId = createData.vault.id;
        }
      } catch {}

      const newIndex = vaults.length;
      const newPair = newVaultChain === 'erc' ? `ERC ${newIndex - 2}` : `PAIR ${newIndex + 1}`;
      const newVault: Vault = {
        id: createdId,
        pair: newPair,
        name,
        address,
        chainType: newVaultChain,
        accent: newVaultChain === 'erc' ? 'cyan' : 'blue',
        tvl: '$0',
        apy: '—',
        type: 'Custom Vault',
        risk: 'Medium',
        summary,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
      };

      const updatedVaults = [...vaults, newVault];
      vaultsRef.current = updatedVaults;
      setVaults(updatedVaults);

      setAutomations((cur) => [...cur, { mode: 'once', minimum: '', maximum: '', interval: 30, customInterval: '', status: 'stopped', lastAt: null, nextAt: null }]);
      setWalletSessions((cur) => [...cur, { mode: 'private', source: null, address: '', manualAddress: '', balanceBaseUnits: '0', nativeGasBaseUnits: '0', error: '', connecting: false, unlocking: false, hasSigner: false }]);

      // Persist to localStorage
      try {
        const stored = JSON.parse(localStorage.getItem('vaultflow_custom_vaults') || '[]') as Vault[];
        stored.push(newVault);
        localStorage.setItem('vaultflow_custom_vaults', JSON.stringify(stored));
      } catch {}

      setSelectedVault(newIndex);
      setAddVaultOpen(false);
      setNewVaultName('');
      setNewVaultAddress('');
      setNewVaultSummary('');
      setNewVaultSymbol('');
      setNewVaultDecimals('');
    } catch (err) {
      setAddVaultError(err instanceof Error ? err.message : 'Failed to create vault.');
    } finally {
      setSavingVault(false);
    }
  }

  function handleRequestDelete(index: number, targetVault: Vault, e?: React.MouseEvent) {
    if (e) e.stopPropagation();
    if (vaults.length <= 1) {
      alert('Cannot delete the last remaining vault. At least one vault must remain configured.');
      return;
    }
    setDeleteError('');
    setVaultToDelete({ index, vault: targetVault });
    setDeleteModalOpen(true);
  }

  async function handleConfirmDelete() {
    if (!vaultToDelete) return;
    const { index: targetIndex, vault: targetVault } = vaultToDelete;
    if (vaults.length <= 1) {
      setDeleteError('Cannot delete the last remaining vault.');
      return;
    }
    setDeletingVault(true);
    setDeleteError('');

    try {
      // 1. Clear active automation timer for this vault
      if (timersRef.current[targetIndex]) {
        clearTimeout(timersRef.current[targetIndex]!);
        timersRef.current[targetIndex] = null;
      }

      // 2. Clear signer from memory
      signersRef.current[targetIndex] = null;

      // 3. Delete from backend if it is a custom vault
      if (
        targetVault.id &&
        targetVault.id.startsWith('vault-') &&
        !['vault-1', 'vault-2', 'vault-3', 'vault-4', 'vault-5'].includes(targetVault.id)
      ) {
        try {
          await apiRequest(`/api/vaults/custom/${encodeURIComponent(targetVault.id)}`, { method: 'DELETE' });
        } catch {}
      }

      // 4. Update localStorage
      try {
        const storedCustom = JSON.parse(localStorage.getItem('vaultflow_custom_vaults') || '[]') as Vault[];
        const filteredCustom = storedCustom.filter((v) => v.id !== targetVault.id && v.address !== targetVault.address);
        localStorage.setItem('vaultflow_custom_vaults', JSON.stringify(filteredCustom));
      } catch {}

      try {
        const deletedVaultIds = JSON.parse(localStorage.getItem('vaultflow_deleted_vaults') || '[]') as string[];
        if (!deletedVaultIds.includes(targetVault.id)) {
          deletedVaultIds.push(targetVault.id);
          localStorage.setItem('vaultflow_deleted_vaults', JSON.stringify(deletedVaultIds));
        }
      } catch {}

      // 5. Shift refs
      const nextTimers: Record<number, ReturnType<typeof setTimeout> | null> = {};
      const nextSigners: Record<number, UniversalSigner | null> = {};
      const nextGens: Record<number, number> = {};
      Object.keys(timersRef.current).forEach((k) => {
        const keyNum = Number(k);
        if (keyNum < targetIndex) nextTimers[keyNum] = timersRef.current[keyNum];
        else if (keyNum > targetIndex) nextTimers[keyNum - 1] = timersRef.current[keyNum];
      });
      Object.keys(signersRef.current).forEach((k) => {
        const keyNum = Number(k);
        if (keyNum < targetIndex) nextSigners[keyNum] = signersRef.current[keyNum];
        else if (keyNum > targetIndex) nextSigners[keyNum - 1] = signersRef.current[keyNum];
      });
      Object.keys(sessionGenerationRef.current).forEach((k) => {
        const keyNum = Number(k);
        if (keyNum < targetIndex) nextGens[keyNum] = sessionGenerationRef.current[keyNum];
        else if (keyNum > targetIndex) nextGens[keyNum - 1] = sessionGenerationRef.current[keyNum];
      });
      timersRef.current = nextTimers;
      signersRef.current = nextSigners;
      sessionGenerationRef.current = nextGens;

      // 6. Update state arrays
      const nextVaults = vaults.filter((_, i) => i !== targetIndex);
      vaultsRef.current = nextVaults;
      setVaults(nextVaults);

      setAutomations((cur) => {
        const next = cur.filter((_, i) => i !== targetIndex);
        automationsRef.current = next;
        return next;
      });

      setWalletSessions((cur) => {
        const next = cur.filter((_, i) => i !== targetIndex);
        walletSessionsRef.current = next;
        return next;
      });

      setHistory((cur) =>
        cur
          .filter((entry) => entry.vaultIndex !== targetIndex)
          .map((entry) => ({
            ...entry,
            vaultIndex: entry.vaultIndex > targetIndex ? entry.vaultIndex - 1 : entry.vaultIndex,
          }))
      );

      // 7. Adjust selectedVault index
      if (selectedVault === targetIndex) {
        setSelectedVault(Math.max(0, Math.min(targetIndex, nextVaults.length - 1)));
      } else if (selectedVault > targetIndex) {
        setSelectedVault((cur) => cur - 1);
      }

      setDeleteModalOpen(false);
      setVaultToDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete vault.');
    } finally {
      setDeletingVault(false);
    }
  }

  function handleResetDefaultVaults() {
    try {
      localStorage.removeItem('vaultflow_deleted_vaults');
    } catch {}
    void loadConfig();
  }


  const statusLabel = automation.status.toUpperCase();
  const automatedVaultIndexes = automations.map((item, index) => item.mode === 'automation' ? index : -1).filter((index) => index >= 0);
  const allReady = automatedVaultIndexes.length > 0 && automatedVaultIndexes.every((index) => canAutomate(index));

  const actionHint = !walletSession.source ? 'Enter private key or mnemonic to unlock session.'
    : !walletSession.hasSigner ? 'The signer is not unlocked for this vault.'
    : !vault.address || vault.address === 'Not configured' ? 'Configure this vault address first.'
    : !automation.minimum.trim() ? 'Enter an amount to enable the transfer button.'
    : !hasValidRange(automation, currentTokenDecimals) ? automation.mode === 'automation' ? 'Check the amount range and use a frequency of at least 5 seconds.' : `Enter a valid ${currentTokenSymbol} amount.`
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
      {/* Slide Sidebar for All Vaults */}
      <div
        className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden={!sidebarOpen}
      />
      <aside
        className={`vault-sidebar ${sidebarOpen ? 'open' : ''}`}
        aria-label="Vault Strategies Directory"
        aria-hidden={!sidebarOpen}
      >
        <div className="sidebar-header">
          <div className="sidebar-header-title">
            <span className="brand-glyph-sm">V</span>
            <div>
              <h3>Vault Strategies</h3>
              <small>{vaults.length} vaults configured</small>
            </div>
          </div>
          <button
            type="button"
            className="sidebar-close-btn"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close vaults menu"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        <div className="sidebar-filter-tabs">
          <button
            type="button"
            className={sidebarFilter === 'all' ? 'active' : ''}
            onClick={() => setSidebarFilter('all')}
          >
            All ({vaults.length})
          </button>
          <button
            type="button"
            className={sidebarFilter === 'zigchain' ? 'active' : ''}
            onClick={() => setSidebarFilter('zigchain')}
          >
            ZIGChain ({vaults.filter((v) => v.chainType === 'zigchain').length})
          </button>
          <button
            type="button"
            className={sidebarFilter === 'erc' ? 'active' : ''}
            onClick={() => setSidebarFilter('erc')}
          >
            ERC ({vaults.filter((v) => v.chainType === 'erc').length})
          </button>
        </div>

        <div className="sidebar-vaults-list">
          {vaults
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => sidebarFilter === 'all' || item.chainType === sidebarFilter)
            .map(({ item, index }) => (
              <div key={item.id || item.pair} className="sidebar-vault-item-wrap">
                <button
                  type="button"
                  className={`sidebar-vault-item ${selectedVault === index ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedVault(index);
                    setSidebarOpen(false);
                  }}
                >
                  <div className="sidebar-vault-top">
                    <span className={`chain-pill ${item.chainType}`}>
                      {item.chainType === 'erc' ? 'ERC / EVM' : 'ZIGCHAIN'}
                    </span>
                    <span className="sidebar-vault-pair">{item.pair}</span>
                    {walletSessions[index]?.source && (
                      <span className="sidebar-vault-connected" title="Signer unlocked">● UNLOCKED</span>
                    )}
                    <span className={`pair-dot ${item.accent}`} />
                  </div>
                  <div className="sidebar-vault-name">{item.name}</div>
                  <div className="sidebar-vault-meta">
                    <span className="sidebar-vault-stat"><strong>{item.apy}</strong> APY</span>
                    <span className="sidebar-vault-stat"><strong>{item.tvl}</strong> TVL</span>
                    <span className="sidebar-vault-risk">{item.risk} Risk</span>
                  </div>
                  {item.address && item.address !== 'Not configured' && (
                    <div className="sidebar-vault-address">
                      <code>{item.address.slice(0, 10)}...{item.address.slice(-6)}</code>
                    </div>
                  )}
                </button>
                <button
                  type="button"
                  className="sidebar-vault-delete-btn"
                  title={`Delete ${item.name}`}
                  onClick={(e) => handleRequestDelete(index, item, e)}
                  aria-label={`Delete ${item.name}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                </button>
              </div>
            ))}
        </div>

        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-add-vault-btn"
            onClick={() => {
              setSidebarOpen(false);
              setAddVaultOpen(true);
            }}
          >
            + ADD ANOTHER VAULT
          </button>
          <button
            type="button"
            className="sidebar-reset-defaults-btn"
            onClick={handleResetDefaultVaults}
            title="Restore default pre-configured vaults if any were deleted"
          >
            RESTORE DEFAULT VAULTS
          </button>
        </div>
      </aside>

      <nav className="vault-nav" aria-label="Vault selection">
        <div className="nav-brand-section">
          <button
            type="button"
            className="sidebar-trigger-btn"
            onClick={() => setSidebarOpen(true)}
            title="Browse all vaults"
            aria-label="Toggle vaults menu"
          >
            <svg className="trigger-hamburger" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" x2="21" y1="6" y2="6"/><line x1="3" x2="21" y1="12" y2="12"/><line x1="3" x2="21" y1="18" y2="18"/></svg>
            <span className="trigger-label">VAULTS</span>
            <span className="trigger-badge">{vaults.length}</span>
          </button>
          <div className="nav-brand"><span className="brand-glyph">V</span><span>Vaultflow</span></div>
        </div>

        {/* Current Active Vault Switcher Pill */}
        <button
          type="button"
          className="active-vault-pill"
          onClick={() => setSidebarOpen(true)}
          title="Click to browse all vaults"
        >
          <span className={`chain-pill ${vault.chainType}`}>{vault.chainType === 'erc' ? 'ERC' : 'ZIG'}</span>
          <span className="active-vault-name">{vault.name}</span>
          {walletSession.source && <span className="connected-mini" title="Signer unlocked">●</span>}
          <span className={`pair-dot ${vault.accent}`} />
          <svg className="active-vault-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>

        <div className="nav-actions">
          <button className="nav-add-vault-btn" type="button" onClick={() => setAddVaultOpen(true)} title="Add a new vault strategy">
            + ADD VAULT
          </button>
          <div className="account-tools">
            <span className="account-identity">
              <b>{authUser.email.slice(0, 2).toUpperCase()}</b>
              <span><strong>{authUser.email}</strong><small>{authUser.role}</small></span>
            </span>
            {authUser.role === 'ADMIN' && <button type="button" onClick={() => void openUserManagement()}>USERS</button>}
            <button className="logout-button" type="button" onClick={() => void handleLogout()}>LOGOUT</button>
          </div>
        </div>
      </nav>

      {/* Add Vault Dialog Modal */}
      {addVaultOpen && (
        <div className="admin-overlay" role="dialog" aria-modal="true" aria-label="Add new vault">
          <section className="add-vault-panel">
            <header className="add-vault-header">
              <div>
                <span>STRATEGY MANAGEMENT</span>
                <h2>Add Another Vault</h2>
                <p>Configure a new ZIGChain or ERC (EVM) automated vault strategy.</p>
              </div>
              <button type="button" className="modal-close-btn" onClick={() => setAddVaultOpen(false)} aria-label="Close add vault">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </header>
            <form onSubmit={handleAddVault} className="add-vault-form">
              <div className="chain-selector-box">
                <span className="form-label">CHOOSE VAULT TYPE / NETWORK</span>
                <div className="chain-toggle-group">
                  <button
                    type="button"
                    className={`chain-select-btn ${newVaultChain === 'zigchain' ? 'active' : ''}`}
                    onClick={() => setNewVaultChain('zigchain')}
                  >
                    <strong>◈ ZIGChain (Cosmos)</strong>
                    <small>Native Cosmos SDK · zig1… addresses</small>
                  </button>
                  <button
                    type="button"
                    className={`chain-select-btn ${newVaultChain === 'erc' ? 'active' : ''}`}
                    onClick={() => setNewVaultChain('erc')}
                  >
                    <strong>⟠ ERC / EVM</strong>
                    <small>EVM smart contracts · 0x… addresses</small>
                  </button>
                </div>
              </div>

              <div className="form-row">
                <label>
                  <span>VAULT NAME</span>
                  <input
                    type="text"
                    value={newVaultName}
                    onChange={(e) => setNewVaultName(e.target.value)}
                    placeholder={newVaultChain === 'erc' ? 'e.g. Nawa Yield Pool' : 'e.g. High Yield Strategy'}
                    required
                  />
                </label>
                <label>
                  <span>TARGET VAULT ADDRESS</span>
                  <input
                    type="text"
                    value={newVaultAddress}
                    onChange={(e) => setNewVaultAddress(e.target.value)}
                    placeholder={newVaultChain === 'erc' ? '0x...' : 'zig1...'}
                    required
                    spellCheck={false}
                  />
                </label>
              </div>

              <div className="form-row three-col">
                <label>
                  <span>TOKEN SYMBOL</span>
                  <input
                    type="text"
                    value={newVaultSymbol}
                    onChange={(e) => setNewVaultSymbol(e.target.value)}
                    placeholder={newVaultChain === 'erc' ? 'ETH' : 'ZIG'}
                  />
                </label>
                <label>
                  <span>DECIMALS</span>
                  <input
                    type="number"
                    value={newVaultDecimals}
                    onChange={(e) => setNewVaultDecimals(e.target.value)}
                    placeholder={newVaultChain === 'erc' ? '18' : '6'}
                  />
                </label>
                <label>
                  <span>STRATEGY SUMMARY (OPTIONAL)</span>
                  <input
                    type="text"
                    value={newVaultSummary}
                    onChange={(e) => setNewVaultSummary(e.target.value)}
                    placeholder="e.g. Automated liquidity provision"
                  />
                </label>
              </div>

              {addVaultError && <p className="form-error" role="alert">{addVaultError}</p>}

              <button type="submit" className="create-vault-submit" disabled={savingVault}>
                {savingVault ? 'CREATING VAULT…' : 'CREATE & OPEN VAULT'}
              </button>
            </form>
          </section>
        </div>
      )}

      {adminOpen && authUser.role === 'ADMIN' && (
        <div className="admin-overlay" role="dialog" aria-modal="true" aria-label="Company user management">
          <section className="admin-panel">
            <header>
              <div>
                <span>ADMINISTRATION</span>
                <h2>Company accounts</h2>
                <p>Create login access for another team member.</p>
              </div>
              <button type="button" onClick={() => setAdminOpen(false)} aria-label="Close user management">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </header>
            <form onSubmit={handleCreateUser} className="admin-user-create-form">
              <label>
                <span>EMAIL</span>
                <input type="email" value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} placeholder="teammate@company.com" required />
              </label>
              <label>
                <span>TEMPORARY PASSWORD</span>
                <input type="password" minLength={8} value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} placeholder="At least 8 characters" required />
              </label>
              <button type="submit" disabled={creatingUser}>{creatingUser ? 'CREATING…' : 'CREATE ACCOUNT'}</button>
            </form>
            {adminMessage && <p className="admin-message" role="status">{adminMessage}</p>}
            <div className="user-list">
              <div className="user-list-head"><span>ACCOUNT</span><span>ROLE</span><span>STATUS</span></div>
              {companyUsers.map((user) => (
                <div className="user-list-row" key={user.id}>
                  <span><strong>{user.email}</strong><small>Created {new Date(user.createdAt).toLocaleDateString()}</small></span>
                  <b>{user.role}</b>
                  <i>{user.active ? 'ACTIVE' : 'DISABLED'}</i>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* Delete Vault Confirmation Modal */}
      {deleteModalOpen && vaultToDelete && (
        <div className="admin-overlay" role="dialog" aria-modal="true" aria-label="Delete vault confirmation">
          <section className="delete-vault-panel">
            <header className="delete-vault-header">
              <div className="delete-warning-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
              </div>
              <div style={{ flex: 1 }}>
                <span className="danger-tag">CONFIRM DELETION</span>
                <h2>Delete Vault Strategy?</h2>
                <p>Are you sure you want to permanently delete <strong>{vaultToDelete.vault.name}</strong> ({vaultToDelete.vault.pair})?</p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => { setDeleteModalOpen(false); setVaultToDelete(null); }}
                aria-label="Close delete modal"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </header>

            <div className="delete-vault-body">
              <div className="delete-vault-info">
                <div className="delete-info-row">
                  <span>Vault:</span>
                  <strong>{vaultToDelete.vault.name}</strong>
                </div>
                <div className="delete-info-row">
                  <span>Chain:</span>
                  <span className={`chain-pill ${vaultToDelete.vault.chainType}`}>
                    {vaultToDelete.vault.chainType === 'erc' ? 'ERC / EVM' : 'ZIGCHAIN'}
                  </span>
                </div>
                {vaultToDelete.vault.address && vaultToDelete.vault.address !== 'Not configured' && (
                  <div className="delete-info-row">
                    <span>Target Address:</span>
                    <code>{vaultToDelete.vault.address}</code>
                  </div>
                )}
              </div>

              <div className="delete-warning-box">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
                <span>Any active automation schedules and signing sessions for this vault will be stopped immediately.</span>
              </div>

              {deleteError && <p className="delete-vault-error" role="alert">{deleteError}</p>}

              <div className="delete-modal-actions">
                <button
                  type="button"
                  className="cancel-delete-btn"
                  onClick={() => { setDeleteModalOpen(false); setVaultToDelete(null); }}
                  disabled={deletingVault}
                >
                  CANCEL
                </button>
                <button
                  type="button"
                  className="confirm-delete-btn"
                  onClick={() => void handleConfirmDelete()}
                  disabled={deletingVault}
                >
                  {deletingVault ? 'DELETING…' : 'YES, DELETE VAULT'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      <div className="console-content">
        <header className="vault-hero">
          <div className="hero-title">
            <p>
              <span className={`pulse ${vault.accent}`} /> {vault.pair} — {vault.chainType === 'erc' ? 'ERC / EVM' : 'ZIGCHAIN'} VAULT AUTOMATION
            </p>
            <h1><span>{currentTokenSymbol}</span><b>→</b>{vault.name}</h1>
          </div>
          <div className="hero-status">
            <span className="state-pill"><i /> TIMER READY</span>
            <span className={`state-pill ${automation.status}`}>{statusLabel}</span>
            <button className="hero-add-vault-btn" type="button" onClick={() => setAddVaultOpen(true)}>+ ADD VAULT</button>
            <button
              className="hero-delete-vault-btn"
              type="button"
              onClick={() => handleRequestDelete(selectedVault, vault)}
              title="Delete this vault strategy"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
              DELETE VAULT
            </button>
            <button type="button" onClick={() => void disconnectWallet(selectedVault)} disabled={!walletSession.source}>CLEAR SESSION</button>
          </div>
        </header>

        <section className="global-bar">
          <div>
            <span className="global-icon">◎</span>
            <span>
              <strong>Global automation</strong>
              <small>{allReady ? `${automatedVaultIndexes.length} automation schedule${automatedVaultIndexes.length === 1 ? '' : 's'} ready` : 'Choose Automation on at least one vault and complete its settings'}</small>
            </span>
          </div>
          <div className="global-buttons">
            <button type="button" onClick={startAll} disabled={!allReady}>START ALL</button>
            <button type="button" onClick={pauseAll} disabled={!anyRunning}>PAUSE ALL</button>
            <button className="stop" type="button" onClick={stopAll} disabled={!anyActive}>STOP ALL</button>
          </div>
        </section>

        <section className="two-column">
          {/* Wallet Card - Private Key Only */}
          <article className="console-card wallet-card">
            <div className="card-title">
              <span className="title-icon blue">▣</span>
              <div>
                <h2>Private Key Session</h2>
                <p>Unlock an interactive signing session in memory for {vault.name}.</p>
              </div>
            </div>

            {walletSession.source ? (
              <div className="connection-panel">
                <div className="connection-heading">
                  <span className="connection-mark">✓</span>
                  <div>
                    <small>SESSION UNLOCKED · {vault.pair} ({vault.chainType === 'erc' ? 'ERC / EVM' : 'ZIGCHAIN'})</small>
                    <h3>Signer active in memory</h3>
                  </div>
                  <span className="connection-method">PRIVATE KEY</span>
                </div>
                <div className="connected-account">
                  <span>UNLOCKED ADDRESS</span>
                  <code>{walletSession.address}</code>
                  <span>AVAILABLE BALANCE</span>
                  <strong>{formatBaseUnits(walletSession.balanceBaseUnits, currentTokenDecimals)} {currentTokenSymbol}</strong>
                </div>
                <p>Session signer resides in memory and never leaves this tab. Close or clear this session when finished.</p>
                <button className="disconnect-button" type="button" onClick={() => void disconnectWallet(selectedVault)}>
                  CLEAR SESSION & SECRETS
                </button>
              </div>
            ) : (
              <div className="private-form">
                <div className="chain-info-banner">
                  <span>NETWORK:</span>
                  <strong>{vault.chainType === 'erc' ? 'EVM / ERC-Compatible' : `${chainConfig.name} (${chainConfig.id})`}</strong>
                </div>
                <label>
                  <span>WALLET ADDRESS (OPTIONAL VERIFICATION)</span>
                  <input
                    value={walletSession.manualAddress}
                    onChange={(event) => patchWalletSession(selectedVault, { manualAddress: event.target.value })}
                    placeholder={vault.chainType === 'erc' ? '0x...' : 'zig1...'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  <span>PRIVATE KEY OR MNEMONIC</span>
                  <input
                    ref={secretInputRef}
                    type="password"
                    placeholder="32-byte hex key or 12/24-word phrase"
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                </label>
                <div className="warning-note">
                  <b>!</b>
                  <p>
                    <strong>In-memory private key signing only.</strong> Secrets are kept strictly in active browser memory and deleted immediately upon refresh, close, or manual disconnect.
                  </p>
                </div>
                <button className="unlock-button" type="button" onClick={() => void unlockManualSession(selectedVault)} disabled={walletSession.unlocking}>
                  {walletSession.unlocking ? 'DERIVING SIGNER…' : 'UNLOCK SESSION'}
                </button>
                {walletSession.error && <p className="form-error" role="alert">{walletSession.error}</p>}
              </div>
            )}
          </article>

          {/* Vault Card */}
          <article className="console-card vault-card">
            <div className="card-title">
              <span className={`title-icon ${vault.accent}`}>◇</span>
              <div>
                <h2>Vault Details</h2>
                <p>Target destination configuration.</p>
              </div>
              <button className="card-add-vault-btn" type="button" onClick={() => setAddVaultOpen(true)}>
                + ADD VAULT
              </button>
            </div>
            <div className="vault-nameplate">
              <span className={`vault-badge ${vault.accent}`}>{vault.pair}</span>
              <div>
                <small>{vault.chainType === 'erc' ? 'ERC / EVM STRATEGY' : 'ZIGCHAIN STRATEGY'}</small>
                <strong>{vault.name}</strong>
              </div>
              <span className={vault.address && vault.address !== 'Not configured' ? 'configured' : 'not-configured'}>
                {vault.address && vault.address !== 'Not configured' ? 'READY' : 'NOT CONFIGURED'}
              </span>
            </div>
            <p className="vault-summary">{vault.summary}</p>
            <div className="market-snapshot">
              <div><span>TVL</span><strong>{vault.tvl}</strong></div>
              <div><span>Vault APY</span><strong>{vault.apy}</strong></div>
              <div><span>Type</span><strong>{vault.type}</strong></div>
              <div><span>Risk</span><strong>{vault.risk}</strong></div>
            </div>
            <p className="snapshot-note">Verified vault contract destination</p>
            <div className="detail-list">
              <div><span>Vault Target</span><code>{vault.address}</code></div>
              <div><span>Asset / Token</span><strong>{currentTokenSymbol}</strong></div>
              <div><span>Source Balance</span><strong>{walletSession.address ? `${formatBaseUnits(walletSession.balanceBaseUnits, currentTokenDecimals)} ${currentTokenSymbol}` : '—'}</strong></div>
              <div><span>Decimals</span><strong>{currentTokenDecimals}</strong></div>
              <div><span>Total Transferred</span><strong>{formatBaseUnits(totalTransferred, currentTokenDecimals)} {currentTokenSymbol}</strong></div>
              <div><span>Execution Count</span><strong>{successfulHistory.length}</strong></div>
            </div>
            <div className="interface-banner">
              <span>⌁</span>
              <div>
                <strong>{vault.address && vault.address !== 'Not configured' ? `${vault.chainType === 'erc' ? 'ERC / EVM' : 'COSMOS'} TRANSFER READY` : 'VAULT_NOT_CONFIGURED'}</strong>
                <small>
                  {vault.chainType === 'erc'
                    ? `Transfers use EVM RPC (${evmConfig.rpcUrl}) with direct private key execution.`
                    : `Transfers execute on ${chainConfig.name} with standard Cosmos signing.`}
                </small>
              </div>
            </div>
          </article>
        </section>

        {/* Strategy Configuration */}
        <section className="console-card strategy-card">
          <div className="card-title">
            <span className="title-icon orange">◷</span>
            <div>
              <h2>Strategy Configuration</h2>
              <p>Independent schedule and amounts for {vault.name}.</p>
            </div>
            <span className="independent-pill">INDEPENDENT SCHEDULE</span>
          </div>

          <div className="delivery-mode" aria-label="Transfer mode">
            <button className={automation.mode === 'once' ? 'active' : ''} type="button" disabled={automation.status === 'running'} onClick={() => selectDeliveryMode('once')}>
              <strong>Send once</strong>
              <small>One transfer using an exact amount</small>
            </button>
            <button className={automation.mode === 'automation' ? 'active' : ''} type="button" disabled={automation.status === 'running'} onClick={() => selectDeliveryMode('automation')}>
              <strong>Automation</strong>
              <small>Repeat within an amount range</small>
            </button>
          </div>

          <div className="direction-bar">
            <span className="active">SOURCE WALLET <b>→</b> {vault.name.toUpperCase()}</span>
            <span>{vault.chainType === 'erc' ? 'EVM TRANSFER' : 'COSMOS TRANSFER'}</span>
          </div>

          <div className={`amount-grid ${automation.mode === 'once' ? 'single' : ''}`}>
            <label>
              <span>{automation.mode === 'once' ? 'AMOUNT TO SEND' : 'MINIMUM AMOUNT'}</span>
              <div>
                <input
                  value={automation.minimum}
                  onChange={(event) => updateSelectedAutomation({ minimum: event.target.value })}
                  disabled={automation.status === 'running'}
                  inputMode="decimal"
                  placeholder="e.g. 0.1"
                />
                <b>{currentTokenSymbol}</b>
              </div>
            </label>
            <label className="max-field" aria-hidden={automation.mode === 'once'}>
              <span>MAXIMUM AMOUNT</span>
              <div>
                <input
                  value={automation.maximum}
                  onChange={(event) => updateSelectedAutomation({ maximum: event.target.value })}
                  disabled={automation.status === 'running' || automation.mode === 'once'}
                  inputMode="decimal"
                  placeholder="Blank uses minimum"
                  tabIndex={automation.mode === 'once' ? -1 : 0}
                />
                <b>{currentTokenSymbol}</b>
              </div>
            </label>
          </div>

          <div className="amount-note">
            <b>Note:</b> {automation.mode === 'once' ? 'Send once transfers exactly the amount entered above.' : 'Each run chooses an amount between minimum and maximum. Failed transactions automatically pause this vault.'} {currentTokenSymbol} uses {currentTokenDecimals} decimals.
          </div>

          {actionHint && <p className="action-hint">{actionHint}</p>}
          {transferStatus && (
            <div className={`transfer-status ${transferStatus.kind}`} role="status">
              <strong>{transferStatus.kind === 'success' ? 'TRANSFER CONFIRMED' : 'TRANSFER NOT SENT'}</strong>
              <span>{transferStatus.message}</span>
              {transferStatus.hash && <code>{transferStatus.hash}</code>}
            </div>
          )}

          <div className={`automation-fields ${automation.mode === 'automation' ? 'expanded' : ''}`} aria-hidden={automation.mode !== 'automation'}>
            <div>
              <div className="frequency-row">
                <div>
                  <span>EXECUTION FREQUENCY</span>
                  <small>Choose a preset or set your own interval</small>
                </div>
                <div className="frequency-options">
                  {intervals.map((item) => (
                    <button
                      className={!automation.customInterval && automation.interval === item.value ? 'active' : ''}
                      key={item.value}
                      type="button"
                      disabled={automation.status === 'running'}
                      onClick={() => updateSelectedAutomation({ interval: item.value, customInterval: '' })}
                    >
                      {item.label}
                    </button>
                  ))}
                  <label className={automation.customInterval ? 'custom-frequency active' : 'custom-frequency'}>
                    <input
                      type="number"
                      min="5"
                      step="1"
                      value={automation.customInterval}
                      disabled={automation.status === 'running' || automation.mode !== 'automation'}
                      onChange={(event) => setCustomFrequency(event.target.value)}
                      placeholder="Custom"
                      tabIndex={automation.mode === 'automation' ? 0 : -1}
                    />
                    <span>sec</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div className="execution-strip">
            <div>
              <span className={`execution-light ${automation.status}`} />
              <span>
                <small>CURRENT STATUS</small>
                <strong>{sendingVaults.includes(selectedVault) ? 'SENDING' : automation.mode === 'once' ? 'READY' : statusLabel}</strong>
              </span>
            </div>
            <div>
              <small>LAST EXECUTION</small>
              <strong>{automation.lastAt ? new Date(automation.lastAt).toLocaleTimeString() : 'Never'}</strong>
            </div>
            <div>
              <small>NEXT EXECUTION</small>
              <strong>{automation.mode === 'once' ? 'Not scheduled' : automation.status === 'running' ? formatCountdown(automation.nextAt, now) : '—'}</strong>
            </div>
            <div className="strategy-actions">
              {automation.mode === 'once' ? (
                <button
                  className="manual-send primary-action"
                  type="button"
                  onClick={sendManualTransfer}
                  disabled={!canSend(selectedVault) || sendingVaults.includes(selectedVault)}
                >
                  SEND ONCE
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => pauseAutomation(selectedVault)} disabled={automation.status !== 'running'}>
                    PAUSE
                  </button>
                  <button className="danger" type="button" onClick={() => stopAutomation(selectedVault)} disabled={automation.status === 'stopped'}>
                    STOP
                  </button>
                  <button
                    className="start"
                    type="button"
                    onClick={() => startAutomation(selectedVault)}
                    disabled={!canAutomate(selectedVault) || automation.status === 'running'}
                  >
                    {automation.status === 'paused' ? 'RESUME' : 'START AUTOMATION'}
                  </button>
                </>
              )}
            </div>
          </div>
        </section>

        {/* History */}
        <section className="console-card history-card">
          <div className="history-header">
            <div className="card-title">
              <span className="title-icon purple">↗</span>
              <div>
                <h2>Transaction History</h2>
                <p>{vault.pair} · {vault.name}</p>
              </div>
            </div>
            <div className="history-filters">
              {['All', 'Success', 'Pending', 'Failed'].map((item) => (
                <button className={historyFilter === item ? 'active' : ''} type="button" key={item} onClick={() => setHistoryFilter(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
          <div className="table-head">
            <span>TIME</span>
            <span>AMOUNT</span>
            <span>STATUS</span>
            <span>TRANSACTION</span>
          </div>
          {selectedHistory.length ? (
            selectedHistory.map((entry) => (
              <div className="history-row" key={entry.id} title={entry.error}>
                <span>{new Date(entry.time).toLocaleTimeString()} <small>{entry.source}</small></span>
                <strong>{formatBaseUnits(entry.amountBaseUnits, currentTokenDecimals)} {currentTokenSymbol}</strong>
                <span className={`history-status ${entry.status.toLowerCase()}`}>{entry.status}</span>
                <div className="tx-cell">
                  <code>{entry.hash ? `${entry.hash.slice(0, 10)}…${entry.hash.slice(-6)}` : entry.error ? entry.error.slice(0, 34) : 'Broadcasting…'}</code>
                  {entry.hash && (
                    <button
                      className={copiedHash === entry.hash ? 'copied' : ''}
                      type="button"
                      aria-label={copiedHash === entry.hash ? 'Transaction hash copied' : 'Copy transaction hash'}
                      title={copiedHash === entry.hash ? 'Copied' : 'Copy transaction hash'}
                      onClick={() => void copyTransactionHash(entry.hash!)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="history-empty">
              <span>↗</span>
              <strong>No {historyFilter.toLowerCase()} transactions</strong>
              <p>Transactions for this wallet and vault will appear here.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
