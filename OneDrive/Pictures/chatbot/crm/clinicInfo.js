/** Shared clinic facts for all patient-facing replies. */

export function getClinicFacts() {
	const address =
		process.env.CLINIC_ADDRESS ||
		"Row House 7, Suyash Society, Opp. Shabri Hotel, Sector 2, Panvel, Navi Mumbai, Maharashtra";

	return {
		name: process.env.CLINIC_NAME || "Dermaplast Aesthetic Clinic",
		phone: process.env.CLINIC_PHONE || "+91 99880 46049",
		address: String(address).replace(/\s+/g, " ").trim()
	};
}
