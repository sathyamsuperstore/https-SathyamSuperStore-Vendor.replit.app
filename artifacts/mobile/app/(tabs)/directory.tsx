import React from "react";
import { HubTab } from "@/components/HubTab";
import SuppliersScreen from "./suppliers";
import UsersScreen from "./users";

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
      ]}
    />
  );
}
