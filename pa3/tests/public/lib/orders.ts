/**
 * HTTP helper: submit an order to order-api, the one part of the stack
 * these tests talk to over plain HTTP.
 */

import { ORDER_API_URL } from "./env.js";

export interface OrderItem {
  type: "physical" | "digital" | "subscription" | string;
  name: string;
  price: number;
}

export interface OrderResponse {
  orderId: string;
  status: string;
}

export async function submitOrder(
  customerId: string,
  items: OrderItem[],
): Promise<OrderResponse> {
  const res = await fetch(`${ORDER_API_URL}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerId, items }),
  });

  if (res.status !== 202) {
    const body = await res.text();
    throw new Error(
      `expected 202 Accepted from POST /orders, got ${res.status}: ${body}`,
    );
  }

  return (await res.json()) as OrderResponse;
}
