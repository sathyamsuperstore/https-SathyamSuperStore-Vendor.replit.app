import React from "react";
import { HubTab } from "@/components/HubTab";
import SuppliersScreen from "./suppliers";
import UsersScreen from "./users";
import MrpScreen from "./mrp";
import LastSupplyDateScreen from "./last-supply-date";
import LatestPurchasesScreen from "./latest-purchases";
import RodeoItemsScreen from "./rodeo-items";
import RasiItemsScreen from "./rasi-items";

export default function DirectoryHubScreen() {
  return (
    <HubTab
      defaultView="suppliers"
      // Five chips no longer fit on a single row at typical phone
      // widths, so wrap onto two rows here. Other hubs keep the
      // default horizontal scroll.
      chipLayout="wrap"
      views={[
        {
          key: "suppliers",
          label: "Suppliers",
          render: () => <SuppliersScreen />,
        },
        {
          key: "users",
          label: "Users",
          render: () => <UsersScreen />,
        },
        {
          key: "mrp",
          label: "MRP",
          render: () => <MrpScreen />,
        },
        {
          key: "last-supply-date",
          label: "LastSupplyDate",
          render: () => <LastSupplyDateScreen />,
        },
        {
          key: "purchases",
          label: "Latest Purchases",
          render: () => <LatestPurchasesScreen />,
        },
        {
          key: "rodeo-items",
          label: "RodeoItems",
          render: () => <RodeoItemsScreen />,
        },
        {
          key: "rasi-items",
          label: "Rasi Items",
          render: () => <RasiItemsScreen />,
        },
      ]}
    />
  );
}
