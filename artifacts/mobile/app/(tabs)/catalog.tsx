import React from "react";
import { HubTab } from "@/components/HubTab";
import PromoScreen from "./promo";
import BrandReviewScreen from "./brand-review";
import PromoPrintScreen from "./promoprint";
import RPromoPrintScreen from "./rpromoprint";
import PriceTagPreviewScreen from "../pricetag-preview";
import PriceTagReviewScreen from "../pricetag-review";
import PriceTagImgScreen from "../pricetag-img";
import TitleListScreen from "../title-list";
import TagColoursScreen from "../tag-colours";

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
          key: "promoPrint",
          label: "PromoPrint",
          render: () => <PromoPrintScreen />,
        },
        {
          key: "rPromoPrint",
          label: "RPromoPrint",
          render: () => <RPromoPrintScreen />,
        },
        {
          key: "priceTagPreview",
          label: "PriceTag Preview",
          render: () => <PriceTagPreviewScreen />,
        },
        {
          key: "priceTagReview",
          label: "PriceTag Review",
          render: () => <PriceTagReviewScreen />,
        },
        {
          key: "priceTagImg",
          label: "PriceTag IMG",
          render: () => <PriceTagImgScreen />,
        },
        {
          key: "titleList",
          label: "TitleList",
          render: () => <TitleListScreen />,
        },
        {
          key: "tagColours",
          label: "TagColours",
          render: () => <TagColoursScreen />,
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
