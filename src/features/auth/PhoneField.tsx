import { Input, Select } from '@/components/ui';
import { COUNTRIES, countryByCode } from '@/lib/phone';

/** Country (with calling code) and local number, side by side. */
export function PhoneField({
  id,
  country,
  onCountry,
  value,
  onChange,
  invalid,
}: {
  id: string;
  country: string;
  onCountry: (code: string) => void;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  const c = countryByCode(country);
  return (
    <div className="flex gap-2">
      <Select
        id={`${id}-country`}
        value={country}
        onChange={onCountry}
        className="h-11 w-[124px] shrink-0 rounded-xl"
        options={COUNTRIES.map((x) => ({ value: x.code, label: `${x.code} ${x.dial}` }))}
      />
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        placeholder={c.example}
        value={value}
        aria-invalid={invalid || undefined}
        aria-label={`Phone number (${c.name} ${c.dial})`}
        onChange={(e) => onChange(e.target.value.replace(/[^\d\s()+-]/g, '').slice(0, 20))}
        className="min-w-0 flex-1"
      />
    </div>
  );
}
