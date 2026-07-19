import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShop } from "../lib/shop.server";
import { uploadStoreLogoToCloudinary } from "../lib/cloudinary";
import { fetchTicketProducts, type TicketProduct } from "../lib/shopify-data.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const selectedProductIds = (
    await db.shopTicketProduct.findMany({
      where: { shopId: shop.id },
      select: { productId: true },
      orderBy: { createdAt: "asc" },
    })
  ).map((row) => row.productId);

  let products: TicketProduct[] = [];
  let productScopeAvailable = true;
  let productError: string | null = null;
  try {
    products = await fetchTicketProducts(admin, []);
  } catch (error) {
    productScopeAvailable = false;
    productError =
      error instanceof Error ? error.message : "Unable to load products";
  }

  return {
    shopDomain: shop.shopDomain,
    logoUrl: shop.emailLogoUrl,
    cloudinaryConfigured: Boolean(process.env.CLOUDINARY_URL),
    products,
    selectedProductIds,
    productScopeAvailable,
    productError,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "save-products") {
    let productIds: string[] = [];
    try {
      productIds = JSON.parse(String(formData.get("productIds") ?? "[]"));
    } catch {
      return { ok: false, error: "Invalid product selection" };
    }
    const deduped = [...new Set(productIds.map((id) => id.trim()))].filter(
      Boolean,
    );
    // deleteMany + createMany (no skipDuplicates: deduped above; SQLite-safe).
    await db.$transaction([
      db.shopTicketProduct.deleteMany({ where: { shopId: shop.id } }),
      db.shopTicketProduct.createMany({
        data: deduped.map((productId) => ({ shopId: shop.id, productId })),
      }),
    ]);
    return { ok: true, intent, selectedProductIds: deduped };
  }

  if (intent === "upload-logo") {
    if (!process.env.CLOUDINARY_URL) {
      return { ok: false, error: "CLOUDINARY_URL is not configured" };
    }
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return { ok: false, error: "Missing image file" };
    }
    if (!file.type.startsWith("image/")) {
      return { ok: false, error: "File must be an image" };
    }
    const bytes = await file.arrayBuffer();
    const upload = await uploadStoreLogoToCloudinary({
      fileBuffer: Buffer.from(bytes),
      shopDomain: shop.shopDomain,
    });
    await db.shop.update({
      where: { id: shop.id },
      data: { emailLogoUrl: upload.secureUrl },
    });
    return { ok: true, intent, logoUrl: upload.secureUrl };
  }

  return { ok: false, error: "Unknown action" };
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

async function createImageFromUrl(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image"));
    image.src = url;
  });
}

async function cropToBlob(params: {
  imageUrl: string;
  cropAreaPixels: Area;
  outputSize: number;
}) {
  const image = await createImageFromUrl(params.imageUrl);
  const canvas = document.createElement("canvas");
  canvas.width = params.outputSize;
  canvas.height = params.outputSize;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to initialize canvas context");
  }
  context.drawImage(
    image,
    params.cropAreaPixels.x,
    params.cropAreaPixels.y,
    params.cropAreaPixels.width,
    params.cropAreaPixels.height,
    0,
    0,
    params.outputSize,
    params.outputSize,
  );
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to export cropped image"));
          return;
        }
        resolve(blob);
      },
      "image/png",
      0.95,
    );
  });
}

export default function CustomizePage() {
  const data = useLoaderData<typeof loader>();
  const logoFetcher = useFetcher<typeof action>();
  const productsFetcher = useFetcher<typeof action>();

  const [error, setError] = useState<string | null>(null);
  const [selectedImageUrl, setSelectedImageUrl] = useState<string | null>(null);
  const [selectedImageName, setSelectedImageName] = useState<string>("");
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [cropPixels, setCropPixels] = useState<Area | null>(null);
  const [sourceImageSize, setSourceImageSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>(
    data.selectedProductIds,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isUploading = logoFetcher.state !== "idle";
  const isSavingProducts = productsFetcher.state !== "idle";

  useEffect(() => {
    return () => {
      if (selectedImageUrl) {
        URL.revokeObjectURL(selectedImageUrl);
      }
    };
  }, [selectedImageUrl]);

  // Clear the local crop once an upload succeeds (loader revalidates logoUrl).
  useEffect(() => {
    if (logoFetcher.data?.ok && logoFetcher.data.intent === "upload-logo") {
      setSelectedImageUrl(null);
      setSelectedImageName("");
      setCropPixels(null);
    }
  }, [logoFetcher.data]);

  const onCropComplete = useCallback((_area: Area, pixels: Area) => {
    setCropPixels(pixels);
  }, []);

  const handleSelectImage = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        setError("Please select an image file.");
        return;
      }
      const previewUrl = URL.createObjectURL(file);
      const image = await createImageFromUrl(previewUrl).catch(() => null);
      if (!image) {
        URL.revokeObjectURL(previewUrl);
        setError("Unable to read image file.");
        return;
      }
      if (image.width < 400 || image.height < 400) {
        URL.revokeObjectURL(previewUrl);
        setError("Image must be at least 400px by 400px.");
        return;
      }
      if (selectedImageUrl) {
        URL.revokeObjectURL(selectedImageUrl);
      }
      setSourceImageSize({ width: image.width, height: image.height });
      setSelectedImageName(file.name);
      setSelectedImageUrl(previewUrl);
      setZoom(1);
      setCrop({ x: 0, y: 0 });
      setError(null);
    },
    [selectedImageUrl],
  );

  const minimumZoom = useMemo(() => {
    if (!sourceImageSize) return 1;
    const basedOnWidth = 400 / sourceImageSize.width;
    const basedOnHeight = 400 / sourceImageSize.height;
    return clamp(Math.max(basedOnWidth, basedOnHeight), 1, 4);
  }, [sourceImageSize]);

  const handleUpload = useCallback(async () => {
    if (!selectedImageUrl || !cropPixels) {
      setError("Select and crop an image before uploading.");
      return;
    }
    setError(null);
    try {
      const croppedBlob = await cropToBlob({
        imageUrl: selectedImageUrl,
        cropAreaPixels: cropPixels,
        outputSize: 800,
      });
      const formData = new FormData();
      formData.set("intent", "upload-logo");
      formData.set("file", croppedBlob, selectedImageName || "store-logo.png");
      logoFetcher.submit(formData, {
        method: "POST",
        encType: "multipart/form-data",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Logo upload failed");
    }
  }, [cropPixels, selectedImageName, selectedImageUrl, logoFetcher]);

  const toggleProduct = useCallback((productId: string) => {
    setSelectedProductIds((current) =>
      current.includes(productId)
        ? current.filter((id) => id !== productId)
        : [...current, productId],
    );
  }, []);

  const handleSaveProducts = useCallback(() => {
    productsFetcher.submit(
      { intent: "save-products", productIds: JSON.stringify(selectedProductIds) },
      { method: "POST" },
    );
  }, [productsFetcher, selectedProductIds]);

  const uploadError =
    logoFetcher.data && !logoFetcher.data.ok ? logoFetcher.data.error : null;
  const productSaveError =
    productsFetcher.data && !productsFetcher.data.ok
      ? productsFetcher.data.error
      : null;

  return (
    <s-page heading="Customize">
      {!data.cloudinaryConfigured ? (
        <s-banner tone="warning" heading="Cloudinary not configured">
          <s-paragraph>
            CLOUDINARY_URL is not set on the server, so logo uploads are
            disabled.
          </s-paragraph>
        </s-banner>
      ) : null}

      {error || uploadError ? (
        <s-banner tone="critical" heading="Logo error">
          <s-paragraph>{error ?? uploadError}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Email logo">
        <s-paragraph>
          Upload a square store logo used in customer ticket emails. Crop to a
          square before saving. Minimum source size is 400×400px. Store:{" "}
          <strong>{data.shopDomain}</strong>
        </s-paragraph>

        <s-stack direction="block" gap="base">
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            {data.logoUrl ? (
              <img
                src={data.logoUrl}
                alt="Current store logo"
                style={{
                  width: "100%",
                  maxWidth: "220px",
                  aspectRatio: "1 / 1",
                  objectFit: "contain",
                  display: "block",
                }}
              />
            ) : (
              <s-text>No custom logo uploaded yet.</s-text>
            )}
          </s-box>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void handleSelectImage(file);
              event.currentTarget.value = "";
            }}
          />

          <s-stack direction="inline" gap="base">
            <s-button
              onClick={() => fileInputRef.current?.click()}
              {...(!data.cloudinaryConfigured ? { disabled: true } : {})}
            >
              Select image
            </s-button>
            <s-button
              variant="primary"
              onClick={() => void handleUpload()}
              {...(!selectedImageUrl || isUploading || !data.cloudinaryConfigured
                ? { disabled: true }
                : {})}
              {...(isUploading ? { loading: true } : {})}
            >
              Save logo
            </s-button>
          </s-stack>

          {selectedImageUrl ? (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="base">
                <s-text>Crop (square)</s-text>
                <div
                  style={{
                    position: "relative",
                    height: "320px",
                    overflow: "hidden",
                    borderRadius: "8px",
                    background: "#1a1a1a",
                  }}
                >
                  <Cropper
                    image={selectedImageUrl}
                    crop={crop}
                    zoom={zoom}
                    aspect={1}
                    cropShape="rect"
                    showGrid
                    onCropChange={setCrop}
                    onZoomChange={setZoom}
                    onCropComplete={onCropComplete}
                    minZoom={minimumZoom}
                    maxZoom={4}
                  />
                </div>
                <input
                  type="range"
                  min={minimumZoom}
                  max={4}
                  step={0.01}
                  value={zoom}
                  onChange={(event) => setZoom(Number(event.target.value))}
                />
                <s-text>
                  Selected file: {selectedImageName || "(unnamed image)"}
                </s-text>
              </s-stack>
            </s-box>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Ticket products">
        <s-paragraph>
          Choose which products count as event tickets. Only orders with at
          least one selected product generate QR tickets and emails. If none are
          selected, all orders generate tickets.
        </s-paragraph>

        {!data.productScopeAvailable ? (
          <s-banner tone="critical" heading="Unable to load products">
            <s-paragraph>
              {data.productError ??
                "Could not load products from Shopify. Confirm the app has the read_products scope."}
            </s-paragraph>
          </s-banner>
        ) : data.products.length === 0 ? (
          <s-paragraph>No products returned from Shopify.</s-paragraph>
        ) : (
          <div
            style={{
              maxHeight: "320px",
              overflow: "auto",
              border: "1px solid #e1e3e5",
              borderRadius: "8px",
              padding: "12px",
            }}
          >
            <s-stack direction="block" gap="small-300">
              {data.products.map((product) => (
                <s-checkbox
                  key={product.id}
                  label={product.title}
                  details={`ID: ${product.id} • ${product.status}`}
                  checked={selectedProductIds.includes(product.id)}
                  onChange={() => toggleProduct(product.id)}
                />
              ))}
            </s-stack>
          </div>
        )}

        {productSaveError ? (
          <s-banner tone="critical" heading="Could not save">
            <s-paragraph>{productSaveError}</s-paragraph>
          </s-banner>
        ) : null}

        <s-button
          variant="primary"
          onClick={handleSaveProducts}
          {...(isSavingProducts || !data.productScopeAvailable
            ? { disabled: true }
            : {})}
          {...(isSavingProducts ? { loading: true } : {})}
        >
          Save ticket products
        </s-button>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
