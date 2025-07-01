import { RedisClient } from "./mod.ts";

// Comprehensive example demonstrating multi-stream functionality with redis-client
async function main() {
  console.log("Redis Client Multi-Stream Example v0.8.0\n");

  // Create Redis client instance
  const redis = new RedisClient({
    redisHost: "localhost",
    redisPort: 6379,
    serviceName: "multi-stream-demo",
    streamMaxLength: 1000,
    streamConsumerName: "demo-consumer"
  })
  .withMetrics(true)
  .withLogger({
    info: (msg) => console.log(`[INFO] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`),
    warn: (msg) => console.warn(`[WARN] ${msg}`),
    debug: (msg) => console.debug(`[DEBUG] ${msg}`)
  });

  try {
    // Example 1: Basic Multi-Stream Subscription
    console.log("=== Example 1: Basic Multi-Stream Subscription ===\n");
    
    await redis.connectToMultipleEventStreams(
      ["orders", "payments", "inventory", "shipping"],
      {
        handler: async (event) => {
          console.log(`\n📨 Received Event:`);
          console.log(`  Stream: ${event.serviceName}`);
          console.log(`  Event: ${event.event}`);
          console.log(`  Aggregate ID: ${event.aggregateId}`);
          console.log(`  Payload:`, event.payload);
          console.log(`  Headers:`, event.headers);
        },
        consumer: "multi-processor",
        autoAck: true
      }
    );

    // Give some time for the connection to establish
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Example 2: Publishing to Different Streams
    console.log("\n=== Example 2: Publishing to Different Streams ===\n");

    // Publish order created event
    await redis.publishToStream(
      "orders",
      "order.created",
      "order-123",
      { 
        userId: "user-456",
        timestamp: new Date().toISOString()
      },
      {
        orderId: "order-123",
        customerId: "customer-789",
        items: [
          { productId: "prod-1", quantity: 2, price: 29.99 },
          { productId: "prod-2", quantity: 1, price: 49.99 }
        ],
        total: 109.97,
        currency: "USD"
      }
    );
    console.log("✅ Published order.created to orders stream");

    // Publish payment initiated event
    await redis.publishToStream(
      "payments",
      "payment.initiated",
      "payment-456",
      {
        orderId: "order-123",
        userId: "user-456"
      },
      {
        paymentId: "payment-456",
        amount: 109.97,
        currency: "USD",
        method: "credit-card",
        card: {
          last4: "1234",
          brand: "visa"
        }
      }
    );
    console.log("✅ Published payment.initiated to payments stream");

    // Publish inventory check event
    await redis.publishToStream(
      "inventory",
      "inventory.check",
      "inv-check-789",
      {
        orderId: "order-123",
        warehouse: "warehouse-1"
      },
      {
        items: [
          { productId: "prod-1", required: 2, available: 10 },
          { productId: "prod-2", required: 1, available: 5 }
        ],
        status: "available"
      }
    );
    console.log("✅ Published inventory.check to inventory stream");

    // Wait a bit to see events being processed
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Example 3: Advanced Multi-Stream with Event Filtering
    console.log("\n=== Example 3: Advanced Multi-Stream with Event Filtering ===\n");

    // Create another connection that only listens to specific events
    const redis2 = new RedisClient({
      redisHost: "localhost",
      redisPort: 6379,
      serviceName: "filtered-processor"
    });

    await redis2.connectToMultipleEventStreams(
      ["orders", "payments"],
      {
        handler: async (event) => {
          console.log(`\n🎯 Filtered Event: ${event.event}`);
          
          // Process based on event type
          if (event.event === "order.created") {
            // Trigger payment processing
            await redis.publishToStream(
              "payments",
              "payment.requested",
              `payment-${Date.now()}`,
              { orderId: event.aggregateId },
              { 
                amount: event.payload.total,
                currency: event.payload.currency
              }
            );
            console.log("  → Triggered payment request");
          }
          
          if (event.event === "payment.completed") {
            // Trigger shipping
            await redis.publishToStream(
              "shipping",
              "shipment.requested",
              `ship-${Date.now()}`,
              { orderId: event.headers.orderId },
              {
                orderId: event.headers.orderId,
                address: "123 Main St, City, Country"
              }
            );
            console.log("  → Triggered shipment request");
          }
        },
        events: ["order.created", "payment.completed"], // Only listen to these events
        consumer: "workflow-processor",
        autoAck: true
      }
    );

    // Simulate payment completion
    await redis.publishToStream(
      "payments",
      "payment.completed",
      "payment-456",
      {
        orderId: "order-123",
        userId: "user-456"
      },
      {
        paymentId: "payment-456",
        transactionId: "txn-987654",
        status: "success"
      }
    );
    console.log("\n✅ Published payment.completed to trigger workflow");

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Example 4: Stream Health Monitoring
    console.log("\n=== Example 4: Stream Health Monitoring ===\n");

    // Check health of individual streams
    const streams = ["orders", "payments", "inventory", "shipping"];
    for (const stream of streams) {
      const health = await redis.getStreamHealth(stream);
      console.log(`Stream ${stream} health:`, health);
    }

    // Get overall metrics
    console.log("\nOverall metrics:");
    const metrics = redis.getMetrics();
    console.log("- Total operations:", metrics.operations.total);
    console.log("- Successful operations:", metrics.operations.successful);
    console.log("- Average latency:", metrics.latency.avg.toFixed(2), "ms");
    console.log("- Stream metrics:", metrics.streams);

    // Example 5: Batch Publishing to Multiple Streams
    console.log("\n=== Example 5: Batch Publishing ===\n");

    const batchResults = await redis.publishBatchToStream("orders", [
      {
        event: "order.item.packed",
        aggregateId: "order-123",
        headers: { warehouse: "warehouse-1" },
        payload: { productId: "prod-1", packedAt: new Date().toISOString() }
      },
      {
        event: "order.item.packed",
        aggregateId: "order-123",
        headers: { warehouse: "warehouse-1" },
        payload: { productId: "prod-2", packedAt: new Date().toISOString() }
      },
      {
        event: "order.ready.ship",
        aggregateId: "order-123",
        headers: { warehouse: "warehouse-1" },
        payload: { allItemsPacked: true, readyAt: new Date().toISOString() }
      }
    ]);

    console.log("Batch publish results:", batchResults);

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Cleanup
    console.log("\n=== Cleanup ===");
    await redis.close();
    await redis2.close();
    console.log("✅ Connections closed");

  } catch (error) {
    console.error("❌ Error in example:", error);
    await redis.close();
  }
}

// Run the example
main().catch(console.error);