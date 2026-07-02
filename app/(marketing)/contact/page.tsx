import type { Metadata } from 'next';
import { ContactForm } from './ContactForm';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Questions, feedback, or a bug to report — get in touch with KeywordQuarry.',
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Contact us</h1>
      <p className="mt-3 text-gray-600">
        Questions, feedback, or a bug to report — send it over and we&apos;ll
        get back to you by email.
      </p>
      <div className="mt-8">
        <ContactForm />
      </div>
    </div>
  );
}
