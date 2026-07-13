function blocks(body: string) {
  return body.trim().split(/\n\s*\n/);
}

export function LegalBody({ body }: { body: string }) {
  return (
    <article className="legal-body">
      {blocks(body).map((block, index) => {
        if (block.startsWith("### ")) return <h3 key={index}>{block.slice(4)}</h3>;
        if (block.startsWith("## ")) return <h2 key={index}>{block.slice(3)}</h2>;
        if (block.startsWith("# ")) return <h1 key={index}>{block.slice(2)}</h1>;
        const lines = block.split("\n");
        if (lines.every((line) => line.startsWith("- "))) {
          return <ul key={index}>{lines.map((line) => <li key={line}>{line.slice(2)}</li>)}</ul>;
        }
        return <p key={index}>{block}</p>;
      })}
    </article>
  );
}
