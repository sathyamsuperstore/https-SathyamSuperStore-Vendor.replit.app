import React from "react";
import { HubTab } from "@/components/HubTab";
import SuppliersScreen from "./suppliers";
import UsersScreen from "./users";
import MrpScreen from "./mrp";
import LastSupplyDateScreen from "./last-supply-date";

export default function DirectoryHubScreen() {
  return (
    <HubTab
      defaultView="suppliers"
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
      ]}
    />
  );
}
