import { Plus } from "lucide-react";

export type Faq = { question: string; answer: React.ReactNode };

export function FaqList({ items }: { items: Faq[] }) {
  return (
    <div className="faq-list">
      {items.map((item, index) => (
        <details key={item.question} open={index === 0}>
          <summary><span>{item.question}</span><Plus aria-hidden="true" size={21} /></summary>
          <div className="faq-answer">{item.answer}</div>
        </details>
      ))}
    </div>
  );
}
