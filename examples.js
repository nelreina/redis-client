import { RedisClient } from "./mod.ts";

// Example 1: Basic Configuration with Fluent API
const redis = new RedisClient({ 
  redisHost: "localhost",
  serviceName: "example-service" 
})
  .withMetrics(true)
  .withRetries(3, 2000)
  .withLogger({
    info: (msg, meta) => console.log(`[INFO] ${msg}`, meta || ''),
    error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta || ''),
    warn: (msg, meta) => console.warn(`[WARN] ${msg}`, meta || ''),
    debug: (msg, meta) => console.debug(`[DEBUG] ${msg}`, meta || ''),
  });

// Example 2: Middleware Usage
redis.use(async (operation, args, next) => {
  console.log(`Starting ${operation}`);
  const start = Date.now();
  try {
    const result = await next();
    console.log(`${operation} completed in ${Date.now() - start}ms`);
    return result;
  } catch (error) {
    console.error(`${operation} failed:`, error.message);
    throw error;
  }
});

// Example 3: Advanced Stream Configuration
async function streamExample() {
  // Connect with advanced options
  await redis.connectToEventStream("orders", {
    handler: async (event) => {
      console.log(`Processing ${event.event} for ${event.aggregateId}`);
      // Simulate processing
      await new Promise(resolve => setTimeout(resolve, 100));
    },
    events: ["order-created", "order-updated", "order-cancelled"],
    startID: "$",
    consumer: "worker-1",
    group: "order-processors",
    blockTimeout: 5000,
    autoAck: true,
    retries: 3,
    deadLetterStream: "dlq:orders",
    metrics: true
  });

  // Batch publish events
  await redis.publishBatchToStream("orders", [
    { event: "order-created", aggregateId: "order-1", payload: { total: 100 } },
    { event: "order-created", aggregateId: "order-2", payload: { total: 200 } },
    { event: "order-updated", aggregateId: "order-1", payload: { status: "shipped" } },
  ]);
}

// Example 4: Pipeline Operations
async function pipelineExample() {
  const pipeline = redis.pipeline();
  
  pipeline.set("user:1:name", "John Doe");
  pipeline.set("user:1:email", "john@example.com");
  pipeline.expire("user:1:name", 3600);
  pipeline.expire("user:1:email", 3600);
  pipeline.incr("stats:users:total");
  
  const results = await pipeline.exec();
  console.log("Pipeline results:", results);
}

// Example 5: Transaction with Watch
async function transactionExample() {
  const accountKey = "account:123:balance";
  
  // Watch the balance key
  await redis.watch(accountKey);
  
  // Get current balance
  const balance = parseInt(await redis.get(accountKey) || "0");
  
  if (balance >= 100) {
    const transaction = redis.transaction();
    transaction.set(accountKey, String(balance - 100));
    transaction.incr("stats:transactions:total");
    transaction.incr("stats:transactions:amount", 100);
    
    const results = await transaction.exec();
    if (results) {
      console.log("Transaction successful");
    } else {
      console.log("Transaction failed - balance changed");
    }
  }
}

// Example 6: Scanning Large Datasets
async function scanExample() {
  // Efficiently scan through all session keys
  for await (const keys of redis.scan("session:*", 100)) {
    console.log(`Found ${keys.length} session keys`);
    
    // Process keys in batches
    if (keys.length > 0) {
      const values = await redis.mget(keys);
      // Process values...
    }
  }
}

// Example 7: Health Monitoring
async function monitoringExample() {
  // Check overall health
  const health = await redis.getHealth();
  console.log("System health:", health);
  
  // Check specific stream health
  const streamHealth = await redis.getStreamHealth("orders");
  console.log("Orders stream health:", streamHealth);
  
  // Get performance metrics
  const metrics = redis.getMetrics();
  console.log("Performance metrics:", {
    totalOps: metrics.operations.total,
    successRate: (metrics.operations.successful / metrics.operations.total * 100).toFixed(2) + "%",
    avgLatency: metrics.latency.avg.toFixed(2) + "ms",
    p95Latency: metrics.latency.p95 + "ms"
  });
  
  // Get stream-specific metrics
  const streamMetrics = redis.getStreamMetrics("orders");
  console.log("Orders stream metrics:", streamMetrics);
}

// Example 8: Error Handling with Dead Letter Queue
async function errorHandlingExample() {
  // Connect to stream with DLQ
  await redis.connectToEventStream("payments", {
    handler: async (event) => {
      // Simulate some events failing
      if (Math.random() < 0.1) {
        throw new Error("Payment processing failed");
      }
      console.log("Payment processed:", event.aggregateId);
    },
    events: ["payment-initiated"],
    retries: 2,
    deadLetterStream: "dlq:payments",
  });
  
  // Monitor the dead letter queue
  await redis.connectToEventStream("dlq:payments", {
    handler: async (event) => {
      console.error("Failed payment in DLQ:", event);
      // Handle failed payments (send alerts, manual review, etc.)
    }
  });
}

// Example 9: Multi-Stream Subscription
async function multiStreamExample() {
  // Connect to multiple streams with a single connection
  await redis.connectToMultipleEventStreams(
    ["orders", "payments", "inventory", "shipping"],
    {
      handler: async (event) => {
        console.log(`Received ${event.event} from aggregate ${event.aggregateId}`);
        
        // Process based on event type
        switch (event.event) {
          case "order-created":
            console.log("New order:", event.payload);
            // Publish to inventory stream
            await redis.publishToStream("inventory", "reserve-items", event.aggregateId, 
              { orderId: event.aggregateId }, event.payload.items);
            break;
            
          case "payment-completed":
            console.log("Payment received:", event.payload);
            // Publish to shipping stream
            await redis.publishToStream("shipping", "prepare-shipment", event.aggregateId,
              { orderId: event.payload.orderId }, { priority: "standard" });
            break;
            
          case "inventory-reserved":
            console.log("Inventory reserved:", event.payload);
            break;
            
          case "shipment-prepared":
            console.log("Shipment ready:", event.payload);
            break;
        }
      },
      events: ["order-created", "payment-completed", "inventory-reserved", "shipment-prepared"],
      consumer: "multi-processor",
      autoAck: true
    }
  );
  
  // Publish events to different streams
  console.log("\nPublishing events to multiple streams:");
  
  // Create an order
  await redis.publishToStream("orders", "order-created", "order-123", 
    { customerId: "customer-456" }, 
    { items: ["product-1", "product-2"], total: 150.00 }
  );
  console.log("Published order-created to orders stream");
  
  // Process payment
  await redis.publishToStream("payments", "payment-completed", "payment-789",
    { orderId: "order-123" },
    { amount: 150.00, method: "credit-card" }
  );
  console.log("Published payment-completed to payments stream");
  
  // Wait a bit to see the events being processed
  await new Promise(resolve => setTimeout(resolve, 2000));
}

// Run examples
async function main() {
  try {
    await streamExample();
    await pipelineExample();
    await transactionExample();
    await scanExample();
    await monitoringExample();
    await errorHandlingExample();
    await multiStreamExample();
    
    // Cleanup
    await redis.close();
  } catch (error) {
    console.error("Example failed:", error);
    await redis.close();
  }
}

// Uncomment to run
// main();