"use client";

import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Callout, Skeleton } from "@/components/ui";
import { formatCompact, formatNumber, formatPercent } from "@/lib/format";
import type { AudienceBand, AudienceBreakdown } from "@/lib/x/audience";
import { useSegments, type SegmentsQuery } from "./use-segments";

const BAR = "#1d9bf0";
/** Male, Female, Unknown — fixed so the legend colour means the same thing on every campaign. */
const GENDER_COLORS: Record<string, string> = {
  Male: "#1d9bf0",
  Female: "#c084fc",
  Unknown: "#6b7280",
};

/** Who the campaign actually reached, by age band and gender. */
export function AudiencePanel(props: SegmentsQuery) {
  const { data, isLoading, isError, error } = useSegments(props);

  return (
    <section>
      <header>
        <h3 className="text-sm font-semibold text-ink">Audience</h3>
        <p className="mt-0.5 text-xs text-muted">
          Who the delivery reached, inferred by X rather than declared by the
          advertiser.
        </p>
      </header>

      <div className="mt-3">
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : isError ? (
          <Callout tone="warn">{(error as Error).message}</Callout>
        ) : data ? (
          <Body audience={data.audience} />
        ) : null}
      </div>
    </section>
  );
}

function Body({ audience }: { audience: AudienceBreakdown }) {
  if (audience.status !== "ok") {
    return (
      <Callout tone="warn">
        {audience.reason ?? "No audience breakdown available."}
      </Callout>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <AgeChart bands={audience.age} />
        <GenderChart bands={audience.gender} />
      </div>

      {audience.notes.map((note) => (
        <p key={note} className="text-[11px] leading-relaxed text-muted">
          {note}
        </p>
      ))}
    </div>
  );
}

function AgeChart({ bands }: { bands: AudienceBand[] }) {
  if (bands.length === 0) return null;

  return (
    <Card
      title="Impressions by age"
      subtitle="Delivery concentration across age bands."
    >
      <ResponsiveContainer width="100%" height={220}>
        {/* Horizontal, because the bands are an ordered scale and read naturally top to bottom. */}
        <BarChart
          data={bands}
          layout="vertical"
          margin={{ top: 4, right: 12, bottom: 4, left: 4 }}
        >
          <XAxis
            type="number"
            tickFormatter={(value: number) => formatCompact(value)}
            tick={{ fill: "#71767b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={44}
            tick={{ fill: "#71767b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value) => [
              formatNumber(Number(value) || 0),
              "Impressions",
            ]}
          />
          <Bar dataKey="impressions" fill={BAR} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}

function GenderChart({ bands }: { bands: AudienceBand[] }) {
  if (bands.length === 0) return null;

  return (
    <Card title="Gender mix" subtitle="Impression share by gender.">
      <div className="flex items-center gap-4">
        {/* A fixed square box: a percentage width inside flex gives recharts a non-square area and
            the ring gets clipped into an arc. */}
        <div className="size-[150px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={bands}
                dataKey="impressions"
                nameKey="label"
                cx="50%"
                cy="50%"
                innerRadius={44}
                outerRadius={70}
                stroke="none"
              >
                {bands.map((band) => (
                  <Cell
                    key={band.label}
                    fill={GENDER_COLORS[band.label] ?? "#6b7280"}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value) => [
                  formatNumber(Number(value) || 0),
                  "Impressions",
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <dl className="min-w-0 flex-1 space-y-2">
          {bands.map((band) => (
            <div key={band.label} className="flex items-center gap-2 text-xs">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: GENDER_COLORS[band.label] ?? "#6b7280",
                }}
              />
              <dt className="flex-1 text-muted">{band.label}</dt>
              <dd className="nums font-semibold text-ink">
                {formatPercent(band.share, 1)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}

const TOOLTIP_STYLE = {
  background: "#16181c",
  border: "1px solid #2f3336",
  borderRadius: 12,
  fontSize: 12,
} as const;

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h4 className="text-sm font-semibold text-ink">{title}</h4>
      <p className="mt-0.5 text-[11px] text-muted">{subtitle}</p>
      <div className="mt-3">{children}</div>
    </div>
  );
}
