// Shared header for public (non-embedded) brand pages: the brand gradient bar
// and centered logo that links home.
export default function BrandHeader() {
  return (
    <>
      <div
        className="h-1.5 w-full"
        style={{
          background:
            "linear-gradient(90deg, #C7423A 0%, #E86F1D 23%, #F2B544 44%, #8FAF9A 68%, #3F8F83 100%)",
        }}
      />
      <header className="mx-auto flex w-full max-w-6xl items-center justify-center px-6 py-5">
        <a href="/">
          <img
            src="/logowide1.png"
            alt="Frontside Tix"
            style={{
              width: "100%",
              maxWidth: "350px",
              height: "auto",
              display: "block",
            }}
          />
        </a>
      </header>
    </>
  );
}
