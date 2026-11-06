import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const account = "027224425948";
const region = "us-east-1";
const profile = "reinvent-2026-talk";
const stackName = "IncidentTriageDemoApp";
const product = { sku: "demo-widget", name: "Demo Widget", unitPriceCents: 1299, currency: "USD" };

function aws(...args) {
  const result = spawnSync("aws", [...args, "--profile", profile, "--region", region, "--output", "json"], {
    encoding: "utf8",
    env: { ...process.env, AWS_PAGER: "" },
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || `AWS CLI exited with ${result.status}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}

function seed() {
  if (aws("sts", "get-caller-identity").Account !== account) {
    throw new Error(`The ${profile} profile must target account ${account}.`);
  }

  const { Stacks: [stack] } = aws("cloudformation", "describe-stacks", "--stack-name", stackName);
  if (!["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus)
      || !stack.StackId.startsWith(`arn:aws:cloudformation:${region}:${account}:stack/${stackName}/`)) {
    throw new Error("Seed requires a successful deployment of the app stack.");
  }
  const outputs = Object.fromEntries(stack.Outputs.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
  const table = outputs.InventoryTableName;
  const { StackResourceSummaries: resources } = aws("cloudformation", "list-stack-resources",
    "--stack-name", stack.StackId);
  if (!table || outputs.ProductSku !== product.sku || !resources.some(
    ({ ResourceType, PhysicalResourceId }) => ResourceType === "AWS::DynamoDB::Table" && PhysicalResourceId === table,
  )) {
    throw new Error("The deployed inventory table and product do not match the seed target.");
  }

  const key = { sku: { S: product.sku } };
  const item = {
    ...key,
    name: { S: product.name },
    unitPriceCents: { N: String(product.unitPriceCents) },
    currency: { S: product.currency },
    availableQuantity: { N: "1000" },
    productVersion: { S: randomUUID() },
    updatedAt: { S: new Date().toISOString() },
  };
  let writeError;
  try {
    aws("dynamodb", "put-item", "--table-name", table, "--item", JSON.stringify(item),
      "--condition-expression", "attribute_not_exists(sku)");
  } catch (error) {
    writeError = error;
  }
  const { Item: saved } = aws("dynamodb", "get-item", "--table-name", table, "--key", JSON.stringify(key),
    "--consistent-read");
  if (!saved) throw writeError ?? new Error("The seed write did not produce a visible inventory row.");
  const availableQuantity = Number(saved.availableQuantity?.N);
  const unitPriceCents = Number(saved.unitPriceCents?.N);
  if (saved.sku?.S !== product.sku || !saved.name?.S || saved.currency?.S !== "USD"
      || !Number.isSafeInteger(unitPriceCents) || unitPriceCents < 1 || !saved.productVersion?.S
      || !Number.isSafeInteger(availableQuantity) || availableQuantity < 0) {
    throw new Error("The existing demo SKU has invalid inventory fields.");
  }
  console.log(JSON.stringify({
    table,
    sku: product.sku,
    result: saved.productVersion.S === item.productVersion.S ? "inserted" : "already present",
    productVersion: saved.productVersion.S,
    availableQuantity,
  }));
}

try {
  seed();
} catch (error) {
  console.error(`Inventory seed failed. ${error.message}`);
  process.exitCode = 1;
}
