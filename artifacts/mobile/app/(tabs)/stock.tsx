import React from "react";
import { HubTab } from "@/components/HubTab";
import StockUpdScreen from "./stockupd";
import LatestPurchasesScreen from "./latest-purchases";

export default function StockHubScreen() {
  return (
    <HubTab
      defaultView="update"
      views={[
        {
          key: "update",
          label: "Stock Update",
          render: () => <StockUpdScreen />,
        },
        {
          key: "purchases",
          label: "Latest Purchases",
          render: () => <LatestPurchasesScreen />,
        },
      ]}
    />
  );
}
