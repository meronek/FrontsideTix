import { v2 as cloudinary } from "cloudinary";

let cloudinaryConfigured = false;

function ensureCloudinaryConfigured() {
  if (cloudinaryConfigured) {
    return;
  }

  const cloudinaryUrl = process.env.CLOUDINARY_URL?.trim();
  if (!cloudinaryUrl) {
    throw new Error("CLOUDINARY_URL is not configured");
  }

  cloudinary.config({
    cloudinary_url: cloudinaryUrl,
  });

  cloudinaryConfigured = true;
}

export async function uploadStoreLogoToCloudinary(params: {
  fileBuffer: Buffer;
  shopDomain: string;
}) {
  ensureCloudinaryConfigured();

  const publicId = params.shopDomain.replace(/[^a-zA-Z0-9_-]/g, "_");

  return new Promise<{
    secureUrl: string;
    width: number;
    height: number;
  }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "frontsidetix/store-logos",
        public_id: publicId,
        overwrite: true,
        invalidate: true,
        resource_type: "image",
        transformation: [
          { width: 800, height: 800, crop: "fill", gravity: "auto" },
        ],
      },
      (error, result) => {
        if (error || !result?.secure_url) {
          reject(error ?? new Error("Cloudinary upload failed"));
          return;
        }

        resolve({
          secureUrl: result.secure_url,
          width: result.width,
          height: result.height,
        });
      },
    );

    stream.end(params.fileBuffer);
  });
}
