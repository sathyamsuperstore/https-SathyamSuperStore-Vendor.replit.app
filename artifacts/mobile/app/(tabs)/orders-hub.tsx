import React from "react";
import { HubTab } from "@/components/HubTab";
import OrdersScreen from "./orders";
import MyOrdersScreen from "./myorders";

export default function OrdersHubScreen() {
  return (
    <HubTab
      defaultView="place"
      views={[
        {
          key: "place",
          label: "Place Order",
          render: () => <OrdersScreen />,
        },
        {
          key: "my",
          label: "My Orders",
          render: () => <MyOrdersScreen />,
        },
      ]}
    />
  );
}
