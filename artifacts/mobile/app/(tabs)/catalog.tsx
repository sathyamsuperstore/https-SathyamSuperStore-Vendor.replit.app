import React from "react";
import { HubTab } from "@/components/HubTab";
import PromoScreen from "./promo";
import BrandReviewScreen from "./brand-review";
import LatestPurchasesScreen from "./latest-purchases";

export default function CatalogHubScreen() {
  return (
    <HubTab
      defaultView="promo"
      views={[
        { key: "promo", label: "Promo", render: () => <PromoScreen /> },
        {
          key: "promoPrev",
          label: "PromoPrev",
          render: () => <PromoScreen mode="prev" />,
        },
        {
          key: "purchases",
          label: "Latest Purchases",
          render: () => <LatestPurchasesScreen />,
        },
        {
          key: "brand",
          label: "Brand Review",
          render: () => <BrandReviewScreen />,
        },
      ]}
    />
  );
}
