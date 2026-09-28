import { useEffect, useRef, useState } from "react";
import { useAuth, type UserProfile } from "./lib/auth";
import { supabase } from "./lib/supabaseClient";
import { AppShell, type DeliverySlipMode, type Lang, type Page } from "./App";

interface Props {
  onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void;
  lang: Lang;
  setLang: (l: Lang) => void;
}

type ProfileForm = Pick<UserProfile,
  "displayName" | "avatarPath" | "employeeNumber" | "phone" | "department" |
  "position" | "birthDate" | "address" | "bio"
>;

function formFromProfile(profile: UserProfile): ProfileForm {
  return {
    displayName: profile.displayName,
    avatarPath: profile.avatarPath,
    employeeNumber: profile.employeeNumber,
    phone: profile.phone,
    department: profile.department,
    position: profile.position,
    birthDate: profile.birthDate,
    address: profile.address,
    bio: profile.bio,
  };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

export default function ProfilePage({ onNavigate, lang, setLang }: Props) {
  const { profile, updateProfile } = useAuth();
  const [form, setForm] = useState(() => formFromProfile(profile));
  const [avatarUrl, setAvatarUrl] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let disposed = false;
    if (avatarFile || removeAvatar) return;
    if (!profile.avatarPath) {
      setAvatarUrl("");
      return;
    }
    void supabase.storage.from("profile-images").createSignedUrl(profile.avatarPath, 3600)
      .then(({ data }) => { if (!disposed) setAvatarUrl(data?.signedUrl ?? ""); });
    return () => { disposed = true; };
  }, [profile.avatarPath, avatarFile, removeAvatar]);

  useEffect(() => {
    if (!avatarFile) return;
    const url = URL.createObjectURL(avatarFile);
    setAvatarUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  const setField = (key: keyof ProfileForm, value: string) =>
    setForm(previous => ({ ...previous, [key]: value }));

  const chooseAvatar = (file?: File) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Profile image must be JPG, PNG, or WEBP.");
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      setError("Profile image must be 3 MB or smaller.");
      return;
    }
    setError("");
    setAvatarFile(file);
    setRemoveAvatar(false);
  };

  const save = async () => {
    if (form.displayName.trim().length < 2) {
      setError("Employee name must contain at least 2 characters.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    let uploadedPath = "";
    try {
      let nextAvatarPath = removeAvatar ? "" : form.avatarPath;
      if (avatarFile) {
        const extension = avatarFile.type === "image/png" ? "png" : avatarFile.type === "image/webp" ? "webp" : "jpg";
        uploadedPath = `${profile.id}/${crypto.randomUUID()}.${extension}`;
        const upload = await supabase.storage.from("profile-images").upload(uploadedPath, avatarFile, {
          contentType: avatarFile.type,
          cacheControl: "3600",
          upsert: false,
        });
        if (upload.error) throw upload.error;
        nextAvatarPath = uploadedPath;
      }

      const { data, error: saveError } = await supabase.rpc("update_own_profile", {
        p_display_name: form.displayName.trim(),
        p_avatar_path: nextAvatarPath,
        p_employee_number: form.employeeNumber.trim(),
        p_phone: form.phone.trim(),
        p_department: form.department.trim(),
        p_position: form.position.trim(),
        p_birth_date: form.birthDate || null,
        p_address: form.address.trim(),
        p_bio: form.bio.trim(),
      });
      if (saveError) throw saveError;
      const row = data as Record<string, unknown>;
      const updated: UserProfile = {
        ...profile,
        displayName: String(row.display_name ?? form.displayName.trim()),
        avatarPath: String(row.avatar_path ?? nextAvatarPath),
        employeeNumber: String(row.employee_number ?? form.employeeNumber.trim()),
        phone: String(row.phone ?? form.phone.trim()),
        department: String(row.department ?? form.department.trim()),
        position: String(row.position ?? form.position.trim()),
        birthDate: String(row.birth_date ?? form.birthDate),
        address: String(row.address ?? form.address.trim()),
        bio: String(row.bio ?? form.bio.trim()),
      };
      updateProfile(updated);
      setForm(formFromProfile(updated));
      setAvatarFile(null);
      setRemoveAvatar(false);
      // Keep the previous file because an audit undo may restore its path.
      if (updated.avatarPath) {
        const signed = await supabase.storage.from("profile-images").createSignedUrl(updated.avatarPath, 3600);
        setAvatarUrl(signed.data?.signedUrl ?? "");
      } else {
        setAvatarUrl("");
      }
      setNotice("Profile saved. You can undo this change from the Undo button.");
    } catch (err) {
      if (uploadedPath) await supabase.storage.from("profile-images").remove([uploadedPath]);
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const inputClass = "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base outline-none transition focus:border-[#1a3458] focus:ring-2 focus:ring-[#1a3458]/15";
  const labelClass = "block text-sm font-600 text-slate-600";

  return (
    <AppShell onNavigate={onNavigate} title="My Profile" activePage="profile" showBack backTarget="home" backLabel="Home" lang={lang} setLang={setLang}>
      <main className="flex-1 overflow-y-auto p-3 sm:p-6">
        <div className="mx-auto max-w-5xl space-y-4">
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
          {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

          <section className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
            {/* Solid navy, no gradient. The gradient ran across the full width
                and expressed no hierarchy: the band and the title were already
                at the same level, so the colour change was decoration. The
                explanatory sentence underneath went with it, since the fields
                it described are the fields directly below. */}
            <div className="bg-[#1a3458] px-5 py-5 text-white sm:px-8">
              <h2 className="text-lg font-700">Personal details</h2>
            </div>

            <div className="grid gap-7 p-5 sm:p-8 lg:grid-cols-[220px_1fr]">
              <aside>
                <div className="mx-auto flex h-40 w-40 items-center justify-center overflow-hidden rounded-full bg-slate-100 text-5xl font-700 text-slate-400 ring-4 ring-white shadow-md">
                  {avatarUrl && !removeAvatar ? <img src={avatarUrl} alt={form.displayName} className="h-full w-full object-cover" /> : form.displayName.trim().charAt(0).toUpperCase() || "?"}
                </div>
                <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={event => chooseAvatar(event.target.files?.[0])} />
                <button type="button" onClick={() => fileInput.current?.click()} className="mt-5 w-full rounded-md bg-[#1a3458] px-4 py-2.5 text-sm font-700 text-white hover:bg-[#112240]">Choose photo</button>
                {(avatarUrl || profile.avatarPath) && <button type="button" onClick={() => { setAvatarFile(null); setAvatarUrl(""); setRemoveAvatar(true); }} className="mt-2 w-full rounded-md border border-slate-300 px-4 py-2.5 text-sm font-600 text-slate-600 hover:bg-slate-50">Remove photo</button>}
                <p className="mt-3 text-center text-xs leading-5 text-slate-400">JPG, PNG, or WEBP · maximum 3 MB</p>
              </aside>

              <div className="grid gap-5 sm:grid-cols-2">
                <label className={labelClass}>Employee name<input value={form.displayName} maxLength={100} onChange={e => setField("displayName", e.target.value)} className={inputClass} /></label>
                <label className={labelClass}>Employee number<input value={form.employeeNumber} maxLength={40} onChange={e => setField("employeeNumber", e.target.value)} placeholder="e.g. EMP-001" className={inputClass} /></label>
                <label className={labelClass}>Username<input value={`@${profile.username}`} readOnly className={`${inputClass} bg-slate-50 text-slate-500`} /></label>
                <label className={labelClass}>Role<input value={profile.role} readOnly className={`${inputClass} capitalize bg-slate-50 text-slate-500`} /></label>
                <label className={labelClass}>Department<input value={form.department} maxLength={100} onChange={e => setField("department", e.target.value)} placeholder="Production" className={inputClass} /></label>
                <label className={labelClass}>Position<input value={form.position} maxLength={100} onChange={e => setField("position", e.target.value)} placeholder="Machine operator" className={inputClass} /></label>
                <label className={labelClass}>Phone number<input value={form.phone} maxLength={32} inputMode="tel" onChange={e => setField("phone", e.target.value)} className={inputClass} /></label>
                <label className={labelClass}>Date of birth<input type="date" value={form.birthDate} onChange={e => setField("birthDate", e.target.value)} className={inputClass} /></label>
                <label className={`${labelClass} sm:col-span-2`}>Address<textarea value={form.address} maxLength={500} rows={3} onChange={e => setField("address", e.target.value)} className={inputClass} /></label>
                <label className={`${labelClass} sm:col-span-2`}>Employee bio<textarea value={form.bio} maxLength={1000} rows={4} onChange={e => setField("bio", e.target.value)} placeholder="Skills, responsibilities, or a short introduction" className={inputClass} /></label>
              </div>
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4 sm:flex-row sm:justify-end sm:px-8">
              <button type="button" disabled={busy} onClick={() => { setForm(formFromProfile(profile)); setAvatarFile(null); setRemoveAvatar(false); setError(""); setNotice(""); }} className="rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-700 text-slate-700 hover:bg-slate-100 disabled:opacity-50">Reset changes</button>
              <button type="button" disabled={busy} onClick={() => void save()} className="rounded-md bg-[#1a3458] px-6 py-2.5 text-sm font-700 text-white hover:bg-[#112240] disabled:opacity-50">{busy ? "Saving..." : "Save profile"}</button>
            </div>
          </section>
        </div>
      </main>
    </AppShell>
  );
}
