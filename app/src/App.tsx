import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

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
  startedAt: string;
  durationMs: number;
  outcome: string;
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

function errorText(body: unknown, fallback: string): string {
  if (isRecord(body) && typeof body.message === "string" && body.message.trim()) return body.message;
  return fallback;
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
          startedAt,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          outcome: response.ok ? "success" : `${status}${code ? ` · ${code}` : " · request failed"}`,
          requestId,
        });
        return { status, body: parsed as T, requestId };
      } catch (error) {
        const reason = error instanceof DOMException && error.name === "AbortError" ? "request timed out" : "network request failed";
        addHistory({
          id: historyId,
          method,
          path,
          startedAt,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
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
        setCatalogError("The catalog response was incomplete. Try again.");
        return false;
      }
      if (pending && pending.productVersion !== nextProduct.productVersion) {
        clearPendingCheckout();
        setPending(null);
        setPendingMessage("The catalog changed. The older checkout attempt was cleared; choose a new quantity.");
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
      setBusy(reason === "after-order" ? "checkout" : "catalog");
      const result = await callApi<CatalogResponse>("GET", "/api/products", activeCredential);
      setBusy(null);
      if (result.networkError) {
        const message = reason === "after-order" ? "Order confirmed, but the stock refresh could not be completed." : "The catalog could not be loaded.";
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
          setCatalogError("Catalog access expired. Sign in again to refresh stock.");
          setStockRefreshError("Order confirmed, but the stock refresh was not authorized.");
          return false;
        }
        signOut();
        setAuthError("That credential was not accepted.");
        return false;
      }
      if (result.status !== 200 || !applyCatalog(result.body)) {
        const message = errorText(result.body, "The catalog could not be loaded.");
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
    setCredential(nextCredential);
    await refreshCatalog(nextCredential, "login");
  };

  const settleReceipt = useCallback(
    async (body: OrderResponse, status: number, activeCredential: string, source: "checkout" | "status" | "retry") => {
      if (!body.order || !isOrder(body.order)) {
        setCheckoutMessage("The server did not return a complete receipt. Keep the attempt pending and look up its status.");
        setCheckoutMessageTone("error");
        setPendingMessage("The result could not be confirmed. The original checkout remains unresolved.");
        return;
      }
      setReceipt(body.order);
      clearPendingCheckout();
      setPending(null);
      setPendingMessage(null);
      setCheckoutMessage(source === "checkout" && status === 201 ? "Order confirmed." : "Saved order confirmed; no second stock decrement was made.");
      setCheckoutMessageTone("success");
      await refreshCatalog(activeCredential, "after-order");
    },
    [refreshCatalog],
  );

  const placeOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!credential || !product || pending || busy) return;
    const payload: CheckoutPayload = {
      checkoutId: newCheckoutId(),
      sku: product.sku,
      quantity,
      productVersion: product.productVersion,
    };
    const pendingPayload: PendingCheckout = { ...payload, startedAt: new Date().toISOString() };
    if (!savePendingCheckout(pendingPayload)) {
      setCheckoutMessage("This browser could not save the checkout safely, so no order was submitted. Check that session storage is available and try again.");
      setCheckoutMessageTone("error");
      return;
    }
    setCheckoutMessageTone("success");
    setPending(pendingPayload);
    setPendingMessage("This checkout is being reconciled. Keep this page open if the response is delayed.");
    setCheckoutMessage(null);
    setBusy("checkout");
    const result = await callApi<OrderResponse>("POST", "/api/checkout", credential, payload);
    setBusy(null);
    if (result.networkError) {
      setPendingMessage("The response was not received. The order may have committed; look up its status or retry the same ID.");
      return;
    }
    if (result.status === 200 || result.status === 201) {
      await settleReceipt(result.body, result.status, credential, "checkout");
      return;
    }
    if (result.status === 401) {
      setPendingMessage("The credential expired before this result was confirmed. Sign in again to reconcile it.");
      signOut();
      return;
    }
    if (result.status >= 500 || result.status === 404) {
      setPendingMessage(`The checkout remains unresolved (${responseCode(result.body) ?? "service failure"}). Look up its status or retry the same ID.`);
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
      setPendingMessage("Status could not be read. The original checkout remains unresolved.");
      return;
    }
    if (result.status === 200) {
      await settleReceipt(result.body, result.status, credential, "status");
      return;
    }
    if (result.status === 401) {
      setPendingMessage("Sign in again to reconcile this checkout.");
      signOut();
      return;
    }
    if (result.status === 404) {
      setPendingMessage("No order is visible yet. The earlier attempt remains uncertain; retry with the same ID when ready.");
      return;
    }
    setPendingMessage(`Status is still unresolved (${responseCode(result.body) ?? "service failure"}). Retry the status lookup or the same checkout.`);
  };

  const retryOrder = async () => {
    if (!credential || !pending || busy) return;
    setBusy("retry");
    const result = await callApi<OrderResponse>("POST", "/api/checkout", credential, wirePayload(pending));
    setBusy(null);
    if (result.networkError) {
      setPendingMessage("The retry response was not received. The same checkout ID remains unresolved.");
      return;
    }
    if (result.status === 200 || result.status === 201) {
      await settleReceipt(result.body, result.status, credential, "retry");
      return;
    }
    if (result.status === 401) {
      setPendingMessage("Sign in again to retry this checkout.");
      signOut();
      return;
    }
    setPendingMessage(`The retry did not settle the earlier attempt (${responseCode(result.body) ?? "request rejected"}). Keep it pending until status or a confirmed receipt resolves it.`);
  };

  const refresh = async () => {
    if (!credential || busy) return;
    await refreshCatalog(credential, "refresh");
  };

  useEffect(() => {
    if (!credential && pending) setPendingMessage("A saved checkout is waiting for reconciliation. Sign in to look up its status.");
  }, [credential, pending]);

  const total = useMemo(() => (product ? product.unitPriceCents * quantity : 0), [product, quantity]);
  const isAuthenticated = credential !== null;
  const isCheckoutBusy = busy === "checkout";

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Incident triage demo</p>
          <h1>Authenticated checkout</h1>
          <p className="lede">Place one durable order and keep its outcome visible, even when a response or stock refresh is uncertain.</p>
        </div>
        {isAuthenticated && <button className="button button-secondary" type="button" onClick={signOut} disabled={busy !== null}>Sign out</button>}
      </header>

      {!isAuthenticated ? (
        <section className="card auth-card" aria-labelledby="sign-in-heading">
          <div className="section-heading">
            <div><p className="eyebrow">Presenter access</p><h2 id="sign-in-heading">Sign in to view the catalog</h2></div>
            <span className="status-dot status-dot-neutral">Signed out</span>
          </div>
          <p className="muted">Your credential stays in page memory and is never written to browser storage.</p>
          <form className="auth-form" onSubmit={onSignIn}>
            <label htmlFor="credential">Presenter credential</label>
            <div className="inline-form">
              <input id="credential" name="credential" type="password" autoComplete="current-password" value={credentialInput} onChange={(event) => setCredentialInput(event.target.value)} placeholder="Enter credential" />
              <button className="button button-primary" type="submit" disabled={busy === "catalog"}>{busy === "catalog" ? "Loading…" : "Sign in"}</button>
            </div>
          </form>
          {authError && <p className="callout callout-error" role="alert">{authError}</p>}
          {pending && <p className="callout callout-warning">{pendingMessage ?? "A saved checkout is waiting for reconciliation."}</p>}
        </section>
      ) : (
        <>
          <section className="card product-card" aria-labelledby="catalog-heading">
            <div className="section-heading">
              <div><p className="eyebrow">Catalog</p><h2 id="catalog-heading">Current product</h2></div>
              <span className={`status-dot ${catalogReady ? "status-dot-success" : "status-dot-warning"}`}>{catalogReady ? "Authenticated" : "Catalog unavailable"}</span>
            </div>
            {product ? (
              <div className="product-layout">
                <div><h3>{product.name}</h3><p className="sku">SKU {product.sku}</p><p className="price">{formatMoney(product.unitPriceCents, product.currency)} <span>per unit</span></p></div>
                <dl className="stats"><div><dt>Available stock</dt><dd>{product.availableQuantity.toLocaleString()}</dd></div><div><dt>Last refreshed</dt><dd>{formatTime(observedAt)}</dd></div></dl>
              </div>
            ) : <div className="empty-state"><p>Catalog unavailable.</p><p className="muted">Refresh when the service is ready.</p></div>}
            <div className="card-actions"><button className="button button-secondary" type="button" onClick={refresh} disabled={busy !== null}>{busy === "catalog" ? "Refreshing…" : "Refresh stock"}</button>{catalogError && <span className="inline-error" role="alert">{catalogError}</span>}</div>
            {stockRefreshError && <p className="callout callout-warning" role="status">{stockRefreshError} The confirmed receipt below is unchanged.</p>}
          </section>

          <section className="card checkout-card" aria-labelledby="checkout-heading">
            <div className="section-heading"><div><p className="eyebrow">Checkout</p><h2 id="checkout-heading">Choose a quantity</h2></div>{pending ? <span className="status-dot status-dot-warning">Unresolved</span> : <span className="status-dot status-dot-neutral">Ready</span>}</div>
            <form className="checkout-form" onSubmit={placeOrder}>
              <div className="quantity-control"><label htmlFor="quantity">Quantity</label><select id="quantity" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} disabled={!product || busy !== null || Boolean(pending)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} {value === 1 ? "unit" : "units"}</option>)}</select></div>
              <div className="order-total"><span>Total</span><strong>{product ? formatMoney(total, product.currency) : "—"}</strong></div>
              <button className="button button-primary button-large" type="submit" disabled={!product || busy !== null || Boolean(pending)}>{isCheckoutBusy ? "Placing order…" : pending ? "Resolve saved checkout first" : "Place order"}</button>
            </form>
            {checkoutMessage && <p className={`callout callout-${checkoutMessageTone}`} role={checkoutMessageTone === "error" ? "alert" : "status"}>{checkoutMessage}</p>}
            {pending && <div className="pending-panel" role="status"><div><p className="eyebrow">Saved attempt</p><h3>Checkout response needs reconciliation</h3><p className="muted">ID <code>{pending.checkoutId}</code> · {pending.quantity} {pending.quantity === 1 ? "unit" : "units"} · Started <time dateTime={pending.startedAt}>{formatTime(pending.startedAt)}</time></p><p>{pendingMessage ?? "The original request may have committed. Check its durable status before starting another order."}</p></div><div className="pending-actions"><button className="button button-secondary" type="button" onClick={lookupStatus} disabled={busy !== null}>{busy === "status" ? "Looking up…" : "Look up status"}</button><button className="button button-primary" type="button" onClick={retryOrder} disabled={busy !== null}>{busy === "retry" ? "Retrying…" : "Retry same checkout"}</button></div></div>}
          </section>

          {receipt && <section className="card receipt-card" aria-labelledby="receipt-heading"><div className="section-heading"><div><p className="eyebrow">Confirmed receipt</p><h2 id="receipt-heading">Order placed</h2></div><span className="status-dot status-dot-success">Saved</span></div><dl className="receipt-grid"><div><dt>Checkout ID</dt><dd><code>{receipt.checkoutId}</code></dd></div><div><dt>Quantity</dt><dd>{receipt.quantity}</dd></div><div><dt>Total</dt><dd>{formatMoney(receipt.totalPriceCents, receipt.currency)}</dd></div><div><dt>Created</dt><dd>{formatTime(receipt.createdAt)}</dd></div></dl><p className="muted">This receipt is durable. A later stock refresh failure does not undo the order.</p></section>}

          <section className="card history-card" aria-labelledby="history-heading">
            <div className="section-heading"><div><p className="eyebrow">Request evidence</p><h2 id="history-heading">Recent page requests</h2></div><span className="history-count">{history.length} / {HISTORY_LIMIT}</span></div>
            {history.length === 0 ? <p className="muted">Requests from this page will appear here with timing and server correlation IDs.</p> : <div className="history-table-wrap"><table><thead><tr><th scope="col">Started</th><th scope="col">Request</th><th scope="col">Outcome</th><th scope="col">Duration</th><th scope="col">Server ID</th></tr></thead><tbody>{history.map((entry) => <tr key={entry.id}><td>{formatTime(entry.startedAt)}</td><td><code>{entry.method} {entry.path}</code></td><td><span className={entry.outcome === "success" ? "table-success" : "table-warning"}>{entry.outcome}</span></td><td>{formatDuration(entry.durationMs)}</td><td>{entry.requestId ? <code>{entry.requestId}</code> : <span className="muted">—</span>}</td></tr>)}</tbody></table></div>}
          </section>
        </>
      )}
    </main>
  );
}

export { App };
