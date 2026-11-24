import { FormEvent, useCallback, useMemo, useState } from "react";

const PENDING_STORAGE_KEY = "incident-triage.pending-checkout.v1";
const HISTORY_LIMIT = 12;
const REQUEST_TIMEOUT_MS = 15_000;

type Product = {
  sku: string;
  name: string;
  unitPriceCents: number;
  currency: string;
  availableQuantity: number;
  productVersion: string;
};

type Order = {
  checkoutId: string;
  sku: string;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
  currency: string;
  createdAt: string;
  status: "placed" | string;
};

type CheckoutPayload = {
  checkoutId: string;
  sku: string;
  quantity: number;
  productVersion: string;
};

type PendingCheckout = CheckoutPayload & {
  startedAt: string;
};

type CatalogResponse = {
  products?: Product[];
  observedAt?: string;
  requestId?: string;
};

type OrderResponse = {
  order?: Order;
  requestId?: string;
  code?: string;
  message?: string;
  checkoutId?: string;
};

type ApiResult<T> = {
  status: number;
  body: T;
  requestId?: string;
  networkError?: string;
};

type RequestHistoryEntry = {
  id: string;
  method: string;
  path: string;
  checkoutId?: string;
  startedAt: string;
  durationMs: number;
  outcome: string;
  tone: "success" | "warning" | "error";
  requestId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProduct(value: unknown): value is Product {
  return (
    isRecord(value) &&
    typeof value.sku === "string" &&
    typeof value.name === "string" &&
    typeof value.unitPriceCents === "number" &&
    Number.isSafeInteger(value.unitPriceCents) &&
    value.unitPriceCents >= 0 &&
    typeof value.currency === "string" &&
    typeof value.availableQuantity === "number" &&
    Number.isSafeInteger(value.availableQuantity) &&
    value.availableQuantity >= 0 &&
    typeof value.productVersion === "string" &&
    value.productVersion.length > 0
  );
}

function isOrder(value: unknown): value is Order {
  return (
    isRecord(value) &&
    typeof value.checkoutId === "string" &&
    typeof value.sku === "string" &&
    Number.isSafeInteger(value.quantity) &&
    Number.isSafeInteger(value.unitPriceCents) &&
    Number.isSafeInteger(value.totalPriceCents) &&
    typeof value.currency === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.status === "string"
  );
}

function readPendingCheckout(): PendingCheckout | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.checkoutId !== "string" ||
      typeof value.sku !== "string" ||
      typeof value.quantity !== "number" ||
      !Number.isSafeInteger(value.quantity) ||
      value.quantity < 1 ||
      value.quantity > 5 ||
      typeof value.productVersion !== "string" ||
      value.productVersion.length === 0
    ) {
      window.sessionStorage.removeItem(PENDING_STORAGE_KEY);
      return null;
    }
    return {
      checkoutId: value.checkoutId,
      sku: value.sku,
      quantity: value.quantity,
      productVersion: value.productVersion,
      // Older pending records did not retain a local start time. Preserve the
      // attempt and give that legacy record a safe re-entry timestamp.
      startedAt: typeof value.startedAt === "string" && !Number.isNaN(Date.parse(value.startedAt))
        ? value.startedAt
        : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function savePendingCheckout(payload: PendingCheckout): boolean {
  try {
    window.sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function wirePayload(pending: PendingCheckout): CheckoutPayload {
  const { checkoutId, sku, quantity, productVersion } = pending;
  return { checkoutId, sku, quantity, productVersion };
}

function clearPendingCheckout(): void {
  try {
    window.sessionStorage.removeItem(PENDING_STORAGE_KEY);
  } catch {
    // Storage is best effort; the page state is still settled in memory.
  }
}

function newCheckoutId(): string {
  return window.crypto.randomUUID();
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

function formatTime(value: string | undefined): string {
  if (!value) return "Not observed yet";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "Unknown time";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(value: number): string {
  return `${value.toLocaleString()} ms`;
}

function displayCopy(value: string): string {
  return value
    .replace(/\u00b7/g, " - ")
    .replace(/\p{Dash}/gu, "-");
}

function errorText(body: unknown, fallback: string): string {
  if (isRecord(body) && typeof body.message === "string" && body.message.trim()) return displayCopy(body.message);
  return displayCopy(fallback);
}

function responseCode(body: unknown): string | undefined {
  return isRecord(body) && typeof body.code === "string" ? body.code : undefined;
}

function App() {
  const [credentialInput, setCredentialInput] = useState("");
  const [credential, setCredential] = useState<string | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [catalogReady, setCatalogReady] = useState(false);
  const [observedAt, setObservedAt] = useState<string>();
  const [pending, setPending] = useState<PendingCheckout | null>(() => readPendingCheckout());
  const [receipt, setReceipt] = useState<Order | null>(null);
  const [history, setHistory] = useState<RequestHistoryEntry[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [checkoutMessage, setCheckoutMessage] = useState<string | null>(null);
  const [checkoutMessageTone, setCheckoutMessageTone] = useState<"success" | "error">("success");
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [stockRefreshError, setStockRefreshError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const addHistory = useCallback((entry: RequestHistoryEntry) => {
    setHistory((current) => [entry, ...current].slice(0, HISTORY_LIMIT));
  }, []);

  const callApi = useCallback(
    async <T,>(method: "GET" | "POST", path: string, activeCredential: string, body?: CheckoutPayload): Promise<ApiResult<T>> => {
      const started = performance.now();
      const startedAt = new Date().toISOString();
      const historyId = newCheckoutId();
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let status = 0;
      let requestId: string | undefined;
      try {
        const response = await window.fetch(path, {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${activeCredential}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        status = response.status;
        let parsed: unknown = {};
        try {
          parsed = await response.json();
        } catch {
          parsed = {};
        }
        if (isRecord(parsed) && typeof parsed.requestId === "string") requestId = parsed.requestId;
        const code = responseCode(parsed);
        addHistory({
          id: historyId,
          method,
          path,
          checkoutId: body?.checkoutId,
          startedAt,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          tone: response.ok ? "success" : status >= 500 ? "error" : "warning",
          outcome: response.ok ? "success" : `${status}${code ? ` - ${displayCopy(code)}` : " - request failed"}`,
          requestId,
        });
        return { status, body: parsed as T, requestId };
      } catch (error) {
        const reason = error instanceof DOMException && error.name === "AbortError" ? "request timed out" : "network request failed";
        addHistory({
          id: historyId,
          method,
          path,
          checkoutId: body?.checkoutId,
          startedAt,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          tone: "warning",
          outcome: reason,
        });
        return { status, body: {} as T, networkError: reason };
      } finally {
        window.clearTimeout(timeoutId);
      }
    },
    [addHistory],
  );

  const signOut = useCallback(() => {
    setCredential(null);
    setCredentialInput("");
    setProduct(null);
    setReceipt(null);
    setCatalogReady(false);
    setObservedAt(undefined);
    setCatalogError(null);
    setAuthError(null);
    setCheckoutMessage(null);
    setPendingMessage(null);
    setStockRefreshError(null);
  }, []);

  const applyCatalog = useCallback(
    (body: CatalogResponse) => {
      const nextProduct = body.products?.length === 1 && isProduct(body.products[0]) ? body.products[0] : null;
      if (!nextProduct) {
        setCatalogError("Catalog unavailable. Refresh to try again.");
        return false;
      }
      if (pending && pending.productVersion !== nextProduct.productVersion) {
        clearPendingCheckout();
        setPending(null);
        setCheckoutMessage("New catalog version. Choose a quantity for a new checkout.");
        setCheckoutMessageTone("success");
      }
      setProduct(nextProduct);
      setCatalogReady(true);
      setObservedAt(typeof body.observedAt === "string" ? body.observedAt : new Date().toISOString());
      setCatalogError(null);
      setStockRefreshError(null);
      return true;
    },
    [pending],
  );

  const refreshCatalog = useCallback(
    async (activeCredential: string, reason: "login" | "refresh" | "after-order") => {
      setBusy(reason === "after-order" ? "stock-refresh" : "catalog");
      const result = await callApi<CatalogResponse>("GET", "/api/products", activeCredential);
      setBusy(null);
      if (result.networkError) {
        const message = reason === "after-order" ? "Order confirmed. Stock refresh failed. Refresh stock to try again." : "Catalog unavailable. Refresh to try again.";
        if (reason === "after-order") setStockRefreshError(message);
        else {
          setCatalogReady(false);
          setCatalogError(message);
        }
        return false;
      }
      if (result.status === 401) {
        if (reason === "after-order") {
          setCatalogReady(false);
          setProduct(null);
          setCatalogError("Catalog access expired. Sign in again.");
          setStockRefreshError("Order confirmed. Stock refresh was not authorized. Sign in again.");
          return false;
        }
        signOut();
        setAuthError("Credential not accepted.");
        return false;
      }
      if (result.status !== 200 || !applyCatalog(result.body)) {
        const message = errorText(result.body, "Catalog unavailable. Refresh to try again.");
        if (reason === "after-order") setStockRefreshError(`Order confirmed, but ${message.toLowerCase()}`);
        else {
          setCatalogReady(false);
          setCatalogError(message);
        }
        return false;
      }
      return true;
    },
    [applyCatalog, callApi, signOut],
  );

  const onSignIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextCredential = credentialInput.trim();
    if (!nextCredential) {
      setAuthError("Enter the presenter credential to continue.");
      return;
    }
    setAuthError(null);
    if (pending) setPendingMessage(null);
    setCredential(nextCredential);
    await refreshCatalog(nextCredential, "login");
  };

  const settleReceipt = useCallback(
    async (body: OrderResponse, activeCredential: string) => {
      if (!body.order || !isOrder(body.order)) {
        setCheckoutMessageTone("error");
        setPendingMessage("Receipt unavailable. Check status.");
        return;
      }
      setReceipt(body.order);
      clearPendingCheckout();
      setPending(null);
      setPendingMessage(null);
      setCheckoutMessage(null);
      setCheckoutMessageTone("success");
      await refreshCatalog(activeCredential, "after-order");
    },
    [refreshCatalog],
  );

  const placeOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!credential || !product || !catalogReady || product.availableQuantity < quantity || pending || busy) return;
    const payload: CheckoutPayload = {
      checkoutId: newCheckoutId(),
      sku: product.sku,
      quantity,
      productVersion: product.productVersion,
    };
    const pendingPayload: PendingCheckout = { ...payload, startedAt: new Date().toISOString() };
    if (!savePendingCheckout(pendingPayload)) {
      setCheckoutMessage("Checkout not saved. No order sent. Enable session storage and try again.");
      setCheckoutMessageTone("error");
      return;
    }
    setCheckoutMessageTone("success");
    setReceipt(null);
    setPending(pendingPayload);
    setPendingMessage(null);
    setCheckoutMessage(null);
    setBusy("checkout");
    const result = await callApi<OrderResponse>("POST", "/api/checkout", credential, payload);
    setBusy(null);
    if (result.networkError) {
      setPendingMessage("No response. Check status or retry the same ID.");
      return;
    }
    if (result.status === 200 || result.status === 201) {
      await settleReceipt(result.body, credential);
      return;
    }
    if (result.status === 401) {
      setPendingMessage("Credential expired. Sign in again to reconcile.");
      signOut();
      return;
    }
    if (result.status >= 500 || result.status === 404) {
      setPendingMessage(null);
      return;
    }
    clearPendingCheckout();
    setPending(null);
    setPendingMessage(null);
    setCheckoutMessage(errorText(result.body, "The order was not placed."));
    setCheckoutMessageTone("error");
  };

  const lookupStatus = async () => {
    if (!credential || !pending || busy) return;
    setBusy("status");
    const result = await callApi<OrderResponse>("GET", `/api/orders/${encodeURIComponent(pending.checkoutId)}`, credential);
    setBusy(null);
    if (result.networkError) {
      setPendingMessage("Status unavailable. Check again.");
      return;
    }
    if (result.status === 200) {
      await settleReceipt(result.body, credential);
      return;
    }
    if (result.status === 401) {
      setPendingMessage("Sign in again to reconcile.");
      signOut();
      return;
    }
    if (result.status === 404) {
      setPendingMessage("No order found for this checkout yet.");
      return;
    }
    setPendingMessage(`Status unresolved (${displayCopy(responseCode(result.body) ?? "service failure")}). Retry status or the same ID.`);
  };

  const retryOrder = async () => {
    if (!credential || !pending || busy) return;
    setBusy("retry");
    const result = await callApi<OrderResponse>("POST", "/api/checkout", credential, wirePayload(pending));
    setBusy(null);
    if (result.networkError) {
      setPendingMessage("Retry had no response. Check status.");
      return;
    }
    if (result.status === 200 || result.status === 201) {
      await settleReceipt(result.body, credential);
      return;
    }
    if (result.status === 401) {
      setPendingMessage("Sign in again to retry.");
      signOut();
      return;
    }
    setPendingMessage(result.status >= 500 || result.status === 404 ? null : `Retry unresolved (${displayCopy(responseCode(result.body) ?? "request rejected")}). Check status before retrying.`);
  };

  const refresh = async () => {
    if (!credential || busy) return;
    await refreshCatalog(credential, "refresh");
  };

  const total = useMemo(() => (product ? product.unitPriceCents * quantity : 0), [product, quantity]);
  const failedCheckout = useMemo(
    () => pending ? history.find((entry) => entry.method === "POST" && entry.path === "/api/checkout" && entry.checkoutId === pending.checkoutId && entry.tone !== "success") : undefined,
    [history, pending],
  );
  const isAuthenticated = credential !== null;
  const isCheckoutBusy = busy === "checkout";
  const isStockRefreshBusy = busy === "stock-refresh";
  const orderReady = product !== null && catalogReady && product.availableQuantity >= quantity && busy === null && pending === null;
  const orderStatus = orderReady ? "Ready" : product && catalogReady && product.availableQuantity < quantity ? "Insufficient stock" : "Unavailable";

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <h1>Storefront</h1>
        </div>
        {isAuthenticated && <button className="button button-secondary" type="button" onClick={signOut} disabled={busy !== null}>Sign out</button>}
      </header>

      {!isAuthenticated ? (
        <section className="card auth-card" aria-labelledby="sign-in-heading">
          <div className="section-heading">
            <h2 id="sign-in-heading">Sign in</h2>
          </div>
          <form className="auth-form" onSubmit={onSignIn}>
            <label htmlFor="credential">Presenter credential</label>
            <div className="inline-form">
              <input id="credential" name="credential" type="password" autoComplete="current-password" value={credentialInput} onChange={(event) => setCredentialInput(event.target.value)} placeholder="Enter credential" />
              <button className="button button-primary" type="submit" disabled={busy === "catalog"}>{busy === "catalog" ? "Loading" : "Sign in"}</button>
            </div>
          </form>
          {authError && <p className="callout callout-error" role="alert">{authError}</p>}
          {pending && <p className="callout callout-warning" role="status">Sign in to check your saved checkout.</p>}
        </section>
      ) : (
        <>
          <section className="card purchase-card" aria-labelledby="checkout-heading">
            <div className="section-heading"><h2 id="checkout-heading">{product ? displayCopy(product.name) : "Storefront"}</h2>{!pending && <span className={`status-dot ${orderReady ? "status-dot-neutral" : "status-dot-warning"}`}>{orderStatus}</span>}</div>
            {product ? (
              <div className="product-layout">
                <div><p className="sku">SKU <code>{product.sku}</code></p><p className="price">{formatMoney(product.unitPriceCents, product.currency)} <span>per unit</span></p></div>
                <dl className="stats"><div><dt>Stock</dt><dd>{product.availableQuantity.toLocaleString()}</dd></div><div><dt>Updated</dt><dd>{formatTime(observedAt)}</dd></div></dl>
              </div>
            ) : <div className="empty-state"><p>Catalog unavailable.</p><p className="muted">Refresh stock to try again.</p></div>}
            <div className="card-actions"><button className="button button-secondary" type="button" onClick={refresh} disabled={busy !== null}>{busy === "catalog" || isStockRefreshBusy ? "Refreshing stock" : "Refresh stock"}</button>{catalogError && <span className="inline-error" role="alert">{catalogError}</span>}</div>
            {stockRefreshError && <p className="callout callout-warning" role="status">{stockRefreshError}</p>}
            <form className="checkout-form" onSubmit={placeOrder}>
              <div className="quantity-control"><label htmlFor="quantity">Quantity</label><select id="quantity" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} disabled={!product || busy !== null || Boolean(pending)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} {value === 1 ? "unit" : "units"}</option>)}</select></div>
              <div className="order-total"><span>Total</span><strong>{product ? formatMoney(total, product.currency) : "-"}</strong></div>
              <button className="button button-primary button-large" type="submit" disabled={!orderReady}>{isStockRefreshBusy ? "Refreshing stock" : isCheckoutBusy ? "Placing order" : "Place order"}</button>
            </form>
            {product && catalogReady && product.availableQuantity < quantity && !pending && <p className="callout callout-warning" role="alert">Not enough stock. Choose a smaller quantity.</p>}
            {checkoutMessage && <p className={`callout callout-${checkoutMessageTone}`} role={checkoutMessageTone === "error" ? "alert" : "status"}>{checkoutMessage}</p>}
            {pending && <div className="pending-panel" role="status"><div><h3>Order not confirmed</h3><details className="pending-details"><summary>Attempt details</summary><div className="pending-meta"><span>ID <code>{pending.checkoutId}</code></span><span>{pending.quantity} {pending.quantity === 1 ? "unit" : "units"}</span><span>Started <time dateTime={pending.startedAt}>{formatTime(pending.startedAt)}</time></span></div></details>{pendingMessage && <p>{pendingMessage}</p>}{failedCheckout && <div className="pending-evidence"><span><code>{failedCheckout.method} {failedCheckout.path}</code></span><span className={failedCheckout.tone === "error" ? "table-error" : "table-warning"}>{displayCopy(failedCheckout.outcome)}</span>{failedCheckout.requestId && <span>Server ID <code>{failedCheckout.requestId}</code></span>}</div>}</div><div className="pending-actions"><button className="button button-secondary" type="button" onClick={lookupStatus} disabled={busy !== null}>{busy === "status" ? "Looking up" : "Look up status"}</button><button className="button button-primary" type="button" onClick={retryOrder} disabled={busy !== null}>{busy === "retry" ? "Retrying" : "Retry same checkout"}</button></div></div>}
          </section>

          {receipt && <section className="card receipt-card" aria-labelledby="receipt-heading"><div className="section-heading"><h2 id="receipt-heading">Order placed</h2></div><dl className="receipt-grid"><div><dt>Checkout ID</dt><dd><code>{receipt.checkoutId}</code></dd></div><div><dt>Quantity</dt><dd>{receipt.quantity}</dd></div><div><dt>Total</dt><dd>{formatMoney(receipt.totalPriceCents, receipt.currency)}</dd></div><div><dt>Created</dt><dd>{formatTime(receipt.createdAt)}</dd></div></dl></section>}

          <section className="card history-card" aria-label="Request history">
            <details className="history-details"><summary>Request history ({history.length})</summary>{history.length === 0 ? <p className="muted">No requests yet.</p> : <div className="history-table-wrap"><table><thead><tr><th scope="col">Started</th><th scope="col">Request</th><th scope="col">Outcome</th><th scope="col">Duration</th><th scope="col">Server ID</th></tr></thead><tbody>{history.map((entry) => <tr key={entry.id}><td>{formatTime(entry.startedAt)}</td><td><code>{entry.method} {entry.path}</code></td><td><span className={`table-${entry.tone}`}>{displayCopy(entry.outcome)}</span></td><td>{formatDuration(entry.durationMs)}</td><td>{entry.requestId ? <code>{entry.requestId}</code> : <span className="muted">-</span>}</td></tr>)}</tbody></table></div>}</details>
          </section>
        </>
      )}
    </main>
  );
}

export { App };
